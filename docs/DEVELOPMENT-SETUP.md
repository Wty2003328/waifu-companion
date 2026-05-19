# Development setup

This guide takes a fresh clone to a green `cargo test --workspace`
and a runnable companion-server, on Linux / macOS / Windows. The
Python sidecars and the Tauri desktop shell are optional — only the
Rust workspace and the web UI are required to develop on the core.

## Prerequisites

| Tool         | Minimum | Notes |
|--------------|---------|-------|
| Rust         | 1.88    | `rust-toolchain.toml` pins `stable`. Install via [rustup](https://rustup.rs/). |
| Node.js      | 20      | npm ships with it. |
| Python       | 3.10    | Only needed for the test rigs and the reference sidecars. |
| Tauri CLI    | 2.x     | `cargo install tauri-cli@^2`. Only needed for the desktop shell. |
| Tauri system deps | varies | See <https://tauri.app/start/prerequisites/>. Linux needs webkit2gtk; macOS needs Xcode CLT; Windows needs WebView2 (preinstalled on 11). |

GPU is **not** required for the Rust workspace, the web UI, or
unit tests. It's only needed to actually synthesize speech via the
heavy TTS engines (Qwen3-TTS, GPT-SoVITS) — edge-tts and the OpenAI
proxy run fine on CPU.

## 1. Rust workspace + tests

```bash
git clone https://github.com/Wty2003328/waifu-companion
cd waifu-companion

cargo check --workspace
cargo test  --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

If all three succeed you have a working development environment for
**L1 (compile/lint)** and **L2 (unit/integration tests)** per
[`TESTING-SOP.md`](TESTING-SOP.md).

## 2. Web UI

```bash
cd web
npm install
npm run build            # type-check + bundle to web/dist/
npx tsc --noEmit         # type-check without bundling (faster)
```

Dev mode (proxies API + WS to `companion-server` on `:9181`):

```bash
npm run dev              # http://127.0.0.1:5173
```

## 3. Running companion-server

```bash
cp companion.toml.example companion.toml
$EDITOR companion.toml   # set agent URL, TTS engine, etc.

cargo run --release -p companion-server
# → http://127.0.0.1:9181/
```

## 4. Tauri desktop shell (optional)

The Tauri app bundles `companion-server` as a sidecar binary. Build
the sidecar first, then the Tauri app:

```bash
cargo build -p companion-server --release
cd apps/companion-tauri
cargo tauri build --no-bundle
./target/release/companion-tauri   # .exe on Windows
```

See [`apps/companion-tauri/README.md`](../apps/companion-tauri/README.md)
for the build-script details.

## 5. Python sidecars (optional — only needed for TTS and the test rigs)

The reference TTS sidecars at `tools/avatar/` and the test rigs at
`tts_tools/` need their own Python environment. The Rust side does
not — the sidecars talk over HTTP.

### Picking a Python interpreter

The test rigs resolve their Python interpreter in this order:

1. **`$COMPANION_TTS_PYTHON`** — explicit override. Set this and
   nothing else has to be in `PATH`.
2. A handful of common conda paths (`~/miniconda3/envs/tts/python`,
   `/opt/miniconda3/envs/tts/python`, `E:/miniconda/envs/tts/python.exe`,
   etc.) — useful when you have a dedicated conda env.
3. `sys.executable` — whatever's running the rig.

The recommended setup is a dedicated env, with the path exported once:

```bash
# bash / zsh
export COMPANION_TTS_PYTHON=/path/to/your/python

# PowerShell
$env:COMPANION_TTS_PYTHON = "C:/path/to/python.exe"
```

### Creating a TTS environment with conda

```bash
conda create -n waifu-tts python=3.10 -y
conda activate waifu-tts

# Core HTTP server deps (used by every sidecar)
pip install fastapi uvicorn

# Pick ONE TTS backend's dependency set:

# Qwen3-TTS-1.7B (recommended, multilingual, voice cloning)
pip install torch transformers accelerate librosa soundfile

# GPT-SoVITS (for fine-tuned character voices)
pip install -r tools/avatar/gpt-sovits-requirements.txt   # if you have one
# otherwise follow the GPT-SoVITS upstream install docs.

# edge-tts (free, CPU-only, no clone)
pip install edge-tts

# OpenAI TTS proxy (cloud, no GPU)
pip install openai
```

### Starting a sidecar manually

```bash
$COMPANION_TTS_PYTHON tools/avatar/qwen3_tts_sidecar.py
# → http://127.0.0.1:9890/
```

In normal use, `companion-server` spawns the sidecar via the
`launch_command` set in `companion.toml`. Manual launches are only
useful for testing.

## 6. Running the test rigs

The Python rigs under `tts_tools/` are the L3–L7 tiers of the testing
protocol. They are **not** required for routine development — `cargo
test --workspace` is enough for most changes — but they catch
contract drift and lifecycle bugs that unit tests can't.

```bash
$COMPANION_TTS_PYTHON tts_tools/run_all.py --quick --no-gpu
```

See [`TESTING-SOP.md`](TESTING-SOP.md) for the layer-by-layer
breakdown and what each rig actually proves.

## Common problems

**`error[E0658]: let-chains are unstable`** — your Rust is older than
1.88. Run `rustup update`.

**`error: failed to run custom build command for tauri-build`** —
missing Tauri system deps. Hit the prerequisites link above.

**`Module not found: pixi.js`** — you skipped `npm install` in `web/`.

**Test rig prints `port already bound — refusing to test against
stale processes`** — you have a leftover companion-server or sidecar
listening. Stop it (or in a pinch, kill the OS process holding that
port), then re-run.

**`No module named 'playwright'` from `scripts/e2e_*.py`** —
Playwright isn't in your TTS env on purpose. See
[`TESTING-SOP.md`](TESTING-SOP.md) §L6c.
