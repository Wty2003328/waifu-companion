# TTS Provider Spec — OpenAI-compatible universal port

The companion talks to TTS engines over a single fixed HTTP contract.
Any engine — local (Qwen3-TTS, Piper, F5-TTS, ChatterBox, …) or remote
(api.openai.com, ElevenLabs via proxy) — implements this contract and
plugs in by URL.

The wire format is a strict superset of OpenAI's
`POST /v1/audio/speech` API, with three extension fields under
`x_companion` for things OpenAI doesn't natively cover (per-call
language hint, reference-cloned voice ID, quality preset).

## Why OpenAI-compatible

- Zero-cost interop with real OpenAI TTS, `openedai-speech`,
  `kokoro-fastapi`, `alltalk_tts`, LocalAI, and any other compliant
  server — point the companion at any base URL and it works.
- Extension fields are namespaced under `x_companion` and ignored by
  upstream servers, so requests stay forward-compatible with the real
  OpenAI API.
- The existing companion-side abstraction (custom `POST /tts`) is
  retired and replaced. Concrete sidecars implement the new spec.

## The 4 endpoints

| Route | Purpose |
|-------|---------|
| `POST /v1/audio/speech` | Synthesize speech from text |
| `GET  /v1/audio/voices` | List registered voices |
| `POST /v1/audio/voices/clone` | Register a reference audio → voice_id |
| `GET  /healthz` | Liveness probe for the supervisor |

Sidecars MUST implement all four. Endpoints are case-sensitive. Base
URL is `http://127.0.0.1:<port>` for local sidecars.

## `POST /v1/audio/speech` — synthesis

### Request

```http
POST /v1/audio/speech HTTP/1.1
Content-Type: application/json

{
  "model":           "qwen3-tts-1.7b",
  "input":           "Hello, world.",
  "voice":           "asuna",
  "response_format": "wav",
  "speed":           1.0,
  "stream_format":   "audio",

  "x_companion": {
    "language":   "ja",
    "quality":    "balanced",
    "reference_id": "asuna-v3",
    "seed":       42,
    "advanced":   { "max_new_tokens": 240 }
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | optional | Engine identifier. Sidecars may ignore. |
| `input` | string | **required** | Text to synthesize. ≤ 4096 chars. |
| `voice` | string | **required** | Voice ID — either a preset name registered at startup OR a `voice_id` returned by `/voices/clone`. |
| `response_format` | enum | optional | `wav` (default) \| `mp3` \| `opus` \| `pcm`. Sidecars MUST support `wav`. |
| `speed` | float | optional | 0.25 – 4.0, default 1.0. Best-effort. |
| `stream_format` | enum | optional | `audio` (default, blocking byte stream) \| `sse` (Server-Sent Events). |
| `x_companion.language` | BCP-47 string | optional | Explicit target language. Many local engines need this; OpenAI infers from text. |
| `x_companion.quality` | enum | optional | `fast` \| `balanced` (default) \| `high`. See [Quality preset](#quality-preset). |
| `x_companion.reference_id` | string | optional | Alternative to `voice` for ad-hoc clone routing. |
| `x_companion.seed` | int | optional | Determinism hint. Best-effort. |
| `x_companion.advanced` | object | optional | Engine-specific overrides. Opaque map; sidecars consume what they recognise, ignore the rest. |

### Response — non-streaming (`stream_format: "audio"`)

```http
HTTP/1.1 200 OK
Content-Type: audio/wav
X-Sample-Rate: 24000
X-Channels:    1
X-Format:      wav

<raw audio bytes>
```

| Header | Value |
|--------|-------|
| `Content-Type` | `audio/wav` / `audio/mpeg` / `audio/opus` per `response_format`. |
| `X-Sample-Rate` | Integer Hz. Default 24000. |
| `X-Channels` | 1 (mono) or 2 (stereo). Default 1. |
| `X-Format` | `wav` \| `mp3` \| `opus` \| `pcm` — echoes `response_format`. |

### Response — streaming (`stream_format: "sse"`)

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream

event: audio.chunk
data: {"index":0,"audio":"<base64 wav fragment>","format":"wav","sample_rate":24000}

event: audio.chunk
data: {"index":1,"audio":"<base64 wav fragment>","format":"wav","sample_rate":24000}

event: audio.done
data: {"total_chunks":2}
```

Chunks SHOULD be sentence- or punctuation-aligned where possible.
Each chunk is a self-contained WAV (header + samples) decodable
independently — clients concatenate at the PCM-sample level for
gapless playback.

### Errors

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{ "error": { "type": "invalid_request_error", "message": "..." } }
```

Use 400 for client errors, 404 for unknown voice, 503 for engine not
ready, 500 for internal failures. Body is OpenAI-shaped: `{error: {type, message}}`.

## `GET /v1/audio/voices` — list voices

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "voices": [
    { "id": "asuna",
      "name": "Asuna (default)",
      "language": "ja",
      "engine":   "qwen3-tts-1.7b",
      "cloned":   true,
      "reference_path": "/path/to/asuna.wav" },
    { "id": "alloy", "name": "Alloy", "language": null,
      "engine": "openai-tts-1", "cloned": false }
  ]
}
```

| Field | Notes |
|-------|-------|
| `id` | The string the client passes in `voice` for synthesis. |
| `name` | Human label. |
| `language` | Native language (BCP-47) or null. |
| `engine` | Backend identifier (helps debug). |
| `cloned` | True if registered via `/voices/clone`. |
| `reference_path` | Optional. Where the clone came from. |

## `POST /v1/audio/voices/clone` — register a reference

```http
POST /v1/audio/voices/clone HTTP/1.1
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="name"

asuna-v3
--boundary
Content-Disposition: form-data; name="language"

ja
--boundary
Content-Disposition: form-data; name="reference_text"

この間、コンテン神社で...
--boundary
Content-Disposition: form-data; name="wav_file"; filename="asuna.wav"
Content-Type: audio/wav

<raw wav bytes>
--boundary--
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `wav_file` | file | **required** | Reference audio. WAV preferred; MP3/FLAC accepted at the sidecar's discretion. 3–30s recommended. |
| `name` | string | **required** | Becomes the `voice_id` in subsequent synth calls. Must be `[a-zA-Z0-9_-]+`. |
| `language` | BCP-47 | optional | Hint for the speaker encoder. |
| `reference_text` | string | optional | Transcript of `wav_file`. Some engines (Qwen3-TTS, XTTS) clone better with it. |

### Response

```json
{
  "voice_id": "asuna-v3",
  "engine":   "qwen3-tts-1.7b",
  "ready":    true
}
```

`ready: false` means async embedding extraction is in progress; clients
should poll `GET /v1/audio/voices` until `ready` is true.

## `GET /healthz` — liveness

```http
GET /healthz HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{ "status": "ok", "engine": "qwen3-tts-1.7b", "voices_ready": 1 }
```

Returns 200 when the engine is loaded and ready to serve synth.
Returns 503 if still warming up (post-fork model load).
The supervisor polls this on startup with a deadline (~120s for cold
GPU load) and continues polling as a watchdog.

## Quality preset

The companion exposes a single user-facing knob:

| Preset | Intent | Latency target |
|--------|--------|----------------|
| `fast` | Real-time conversation, snappy chunks | RTF ≤ 0.7 |
| `balanced` | Default — natural prosody, acceptable speed | RTF ≤ 1.2 |
| `high` | Long-form / important responses | RTF ≤ 2.0 |

Each sidecar maps the preset to its own native knobs **internally**.
The client does NOT pass per-knob values for the preset path; only the
preset name. For one-off tuning, clients use `x_companion.advanced`
with backend-specific keys.

Concrete mappings (informative, not contract):

| Backend | `fast` | `balanced` | `high` |
|---------|--------|------------|--------|
| Qwen3-TTS | temp=0.6, top_p=0.70, max_new=200 | temp=0.4, top_p=0.85, max_new=240 | temp=0.3, top_p=0.90, max_new=320 |
| Piper | noise_scale=0.55 | 0.667 | 0.8 |
| ChatterBox | cfg=0.5 | 0.7 | 0.75 |
| OpenAI | model=tts-1 | model=tts-1 | model=tts-1-hd |

Qwen3-TTS temperatures are tuned for voice-clone fidelity (lower =
stricter to the speaker embedding's distribution). The "balanced"
temp of 0.4 was picked by user listening test against the Asuna
concat-best5 (32s) reference; "fast" trades fidelity for speed,
"high" sharpens further at the cost of less prosodic range.

## Launch & lifecycle protocol

The companion is **engine-agnostic**: it knows nothing about which TTS
backend is behind the URL, what weights it loads, or what interpreter
runs it. It only knows the contract on this page. A TTS server is
spec-compliant when it honours **all five** lifecycle rules below.

### Required of every TTS server

1. **Bind a TCP port** — read `TTS_PORT` env var if set; otherwise the
   server's own configured default. Listen on `127.0.0.1:$TTS_PORT`
   (loopback only — these are local sidecars).

2. **Become healthy within `HEALTH_CHECK_TIMEOUT`** — respond to
   `GET /healthz` with `200 OK` once the model is loaded. Return `503`
   while warming up. Companion deadline: 240s.

3. **Honour `POST /shutdown`** — exit cleanly within 8s of receiving
   the request. Run any framework teardown (e.g. `torch.cuda.empty_cache()`,
   `del model`, `sys.exit(0)`) so GPU memory + driver state are released.

4. **Honour SIGTERM/SIGINT/Ctrl-Break** as a fallback — when `/shutdown`
   is unimplemented or the HTTP path is wedged, the companion sends a
   signal and waits up to 5s before `SIGKILL`.

5. **Run as a single process tree** — no orphaned worker pools, no
   double-forks. Killing the launched process must terminate every
   child it spawned (use `multiprocessing.set_start_method("spawn")`
   + propagate signals).

### Companion's lifecycle responsibility

```text
                  ┌─────────────────────────────────────┐
   start_server   │ 1. if launcher_command is set:      │
                  │      Popen(launcher_command)        │
                  │      keep child handle              │
                  │ 2. poll /healthz until 200 or 240s  │
                  └─────────────────────────────────────┘

                  ┌─────────────────────────────────────┐
   synthesize     │ POST /v1/audio/speech … (per call)  │
                  └─────────────────────────────────────┘

                  ┌─────────────────────────────────────┐
   stop_server    │ 1. POST /shutdown  (2s timeout)     │
                  │ 2. wait child.exit  (8s timeout)    │
                  │ 3. SIGTERM child   (5s timeout)     │
                  │ 4. SIGKILL child                    │
                  │ (steps 2-4 skipped if no child)     │
                  └─────────────────────────────────────┘
```

The companion **never** reads `TTS_MODEL_DIR`, `TTS_VOICES_CONFIG`,
reference paths, GPU device, or any engine-specific env. Those belong
to the launcher (see next section) — the companion only knows about
the URL and the synthesis payload.

### Launchers (NOT in companion)

A **launcher** is any script or binary the user (or a launcher
registry like `tts_lab/launch_tts.py`) invokes to bring up a
spec-compliant server. The companion's `launcher_command` is an
**opaque string** — the companion runs it via the OS shell, captures
stdout/stderr to its log, and polls `/healthz`. It does not parse,
template, or validate the command beyond "non-empty string".

A launcher's job is to:

- pick a python interpreter / virtualenv
- pick a model directory + voice references
- set engine-specific env vars (`TTS_MODEL_DIR`, `SBV2_MODEL_NAME`, …)
- exec the actual sidecar script
- propagate its child's signals so the protocol's signal contract holds

Example launchers in this repo:

| Launcher | Engines |
|----------|---------|
| `tts_lab/launch_tts.py --engine <name> --port <n>` | qwen3-tts-1.7b, sbv2-asuna-v2 (extend the registry there) |

Adding a new engine is a launcher-side change. The companion gets one
new line in `companion.toml`: `launcher_command = "…"`.

## Companion-side config

The complete `[avatar.tts]` schema. Eight fields. None are
engine-specific.

```toml
[avatar.tts]
# Required — URL of a TTS Provider Spec v1 server.
api_url                = "http://127.0.0.1:9891"

# Per-call defaults (all overridable per request).
language               = "ja"
voice                  = "asuna_v2"
quality                = "balanced"    # fast | balanced | high
speed                  = 1.0

# Streaming behaviour.
streaming              = true
streaming_target_chars = 80

# Optional — opaque command. If set, companion runs it once at
# startup and tears it down at shutdown via the lifecycle protocol
# above. If unset, companion assumes an externally-managed server
# is already listening at api_url.
launcher_command       = "python C:/.../tts_lab/launch_tts.py --engine sbv2-asuna-v2 --port 9891"
```

That's it. No `engine`, `python`, `model_dir`, `reference_audio`,
`gpu_device`, `use_cuda_graph`, `auto_start`, `close_with_companion` —
all of those moved out (most to launchers; auto-start is implicit;
close-with-companion is always-on).

## Sidecar implementation checklist

A new sidecar minimally must:

1. Read `TTS_PORT`, bind `127.0.0.1:$TTS_PORT`.
2. Load voices from `TTS_VOICES_CONFIG` (or empty if unset).
3. Implement the 4 endpoints with the schemas above.
4. Map `x_companion.quality` to native sampling params (see table).
5. Honour `response_format: "wav"` (mandatory). Other formats optional.
6. Emit `audio/wav` with `X-Sample-Rate` / `X-Channels` / `X-Format`.
7. Return 503 from `/healthz` until model is loaded; 200 after.
8. Honour `POST /shutdown` for graceful cleanup (8s deadline).
9. Exit on SIGTERM/SIGINT as fallback (5s deadline).
10. Run as a single process tree (kill the parent → all children die).

## Versioning

This spec is versioned via a `X-TTS-Provider-Spec: 1` header sidecars
SHOULD emit. The companion checks the header and warns on mismatch.
Bumping major version is backward-incompatible (require client+server
update). Minor changes are additive (new optional fields, new
endpoints) and don't bump version.

Spec version: **1** (2026-05-16).
