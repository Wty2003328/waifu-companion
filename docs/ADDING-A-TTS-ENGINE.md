# Adding a new TTS engine

The companion talks to TTS backends over an HTTP contract — the
[TTS Provider Spec v1](TTS-PROVIDER-SPEC.md). Any server that
implements the four endpoints below works as a drop-in engine; no
Rust changes required.

The two reference sidecars at `tools/avatar/qwen3_tts_sidecar.py`
(local model) and `tools/avatar/openai_proxy_sidecar.py` (cloud
passthrough) are working examples — copy whichever is closer to your
use case.

## The contract

```
POST {api_url}/v1/audio/speech     Content-Type: application/json
    {
      "input":           "...",          // text to synthesize
      "voice":           "asuna",        // a voice_id from /voices
      "speed":           1.0,            // 0.25..3.0
      "response_format": "wav",          // wav | mp3 | pcm | flac
      "stream_format":   "audio",        // audio | sse
      "x_companion":     {               // optional companion hints
        "language":      "ja",
        "quality":       "balanced"      // fast | balanced | high
      }
    }
    → audio bytes
      X-Sample-Rate: 24000
      X-Channels:    1
      X-Format:      wav

GET  {api_url}/v1/audio/voices              → { voices: [...] }
POST {api_url}/v1/audio/voices/clone        (multipart; optional — 501 OK)
GET  {api_url}/healthz                      → 200 once ready
POST {api_url}/shutdown                     → 200 then exit
```

The full spec — required headers, error shapes, fallback rules —
lives in [`TTS-PROVIDER-SPEC.md`](TTS-PROVIDER-SPEC.md). Read that
first; this doc is the operational walkthrough.

## Steps

### 1. Write the server

Pick any language. The reference sidecars use Python + FastAPI
because the TTS backends are Python ML models, but the contract is
language-agnostic — a Rust or Go server works fine. The server is
responsible for:

- Loading the TTS model on startup. Block `/healthz` with `503` until
  it's ready.
- Accepting `POST /v1/audio/speech` and returning audio bytes in the
  requested format.
- Mapping the `x_companion.quality` field to whatever fast/balanced/high
  trade-off your model exposes (sampling steps, beam width, etc.).
- Cleanly shutting down on `POST /shutdown` — the companion calls
  this when it exits, and runs `torch.cuda.empty_cache()`-style
  cleanup if applicable.

### 2. Register voices

Voices are referenced by `voice_id` in `companion.toml`. The sidecar
exposes them via `GET /v1/audio/voices`. How you populate that list
is up to you — Qwen3-TTS reads them from a `voices.toml` of
`{ voice_id, reference_clip_path, transcript }` triples; the OpenAI
proxy hardcodes the six preset names; GPT-SoVITS scans a directory
of `.ckpt` files.

### 3. Wire it into companion.toml

```toml
[avatar.tts]
engine         = "my-engine"             # any label for logs
api_url        = "http://127.0.0.1:9890" # wherever your server listens
port           = 9890
voice          = "my-default-voice"
language       = "ja"
quality        = "balanced"
auto_start     = true                    # let companion-server spawn it
launch_command = "python tools/avatar/my_sidecar.py"
```

If `auto_start = true`, `companion-server` spawns the command, waits
for `GET /healthz` to return 200, then sends synthesis requests.
Env vars `TTS_PORT`, `TTS_MODEL_DIR`, etc. are passed through to the
sidecar — see the existing sidecars for the conventions.

### 4. Test against the wire contract

```bash
# Smoke the spec compliance
$COMPANION_TTS_PYTHON tts_tools/test_server_e2e.py
#   asserts /health, /v1/audio/speech default + sample_steps override,
#   empty-text → 400, /shutdown → exit 0

# Audio integrity through the full pipeline (needs GPU for the heavy engines)
$COMPANION_TTS_PYTHON tts_tools/test_audio_integrity.py
```

If both rigs pass, your engine is shippable. Open a PR adding:

- The sidecar under `tools/avatar/<your_engine>_sidecar.py` (or
  alongside it for non-Python implementations).
- A section under "TTS setup" in the README mentioning the engine
  and its `[avatar.tts]` snippet.
- Either the sidecar's launch command in `companion.toml.example` or
  a brief comment block showing how to switch to it.

That's the whole loop. The companion's TTS-routing layer is
intentionally a thin HTTP client — no per-engine code lives in the
Rust workspace.
