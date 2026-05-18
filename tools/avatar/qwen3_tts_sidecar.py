"""Qwen3-TTS sidecar serving the universal TTS-PROVIDER-SPEC v1.

OpenAI-compatible /v1/audio/speech + voices + voices/clone + healthz.

Launched by the companion via [avatar.tts] launch_command. Reads
configuration from env vars (TTS_PORT, TTS_MODEL_DIR, TTS_VOICES_CONFIG,
TTS_ATTN_IMPL, TTS_DTYPE).

Run standalone for testing:
    set TTS_PORT=9890
    set TTS_MODEL_DIR=C:/path/to/qwen3-tts-1.7b-base
    set TTS_VOICES_CONFIG=C:/path/to/voices.toml
    /e/miniconda/envs/tts/python.exe -m tools.avatar.qwen3_tts_sidecar
"""
from __future__ import annotations

import asyncio
import io
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
try:
    import tomllib  # py3.11+
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore  # py3.10 backport
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

for s in (sys.stdout, sys.stderr):
    try: s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

# Allow this file to be imported either as `tools.avatar.qwen3_tts_sidecar`
# (from companion repo) or run directly. In direct-run mode add the
# parent dir so `qwen3_engine` resolves.
THIS_DIR = Path(__file__).parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

SPEC_VERSION = "1"
ENGINE_ID = "qwen3-tts-1.7b"
SUPPORTED_FORMATS = {"wav"}  # MVP; mp3/opus would need ffmpeg
DEFAULT_SAMPLE_RATE = 24000

# ── Models ─────────────────────────────────────────────────────────────

class XCompanion(BaseModel):
    language: Optional[str] = None
    quality: Optional[str] = Field(default="balanced", pattern=r"^(fast|balanced|high)$")
    reference_id: Optional[str] = None
    seed: Optional[int] = None
    advanced: Optional[dict] = None


class SpeechRequest(BaseModel):
    model: Optional[str] = None
    input: str = Field(..., max_length=4096)
    voice: str
    response_format: str = Field(default="wav", pattern=r"^(wav|mp3|opus|pcm)$")
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    # Only blocking audio is supported now. SSE intra-utterance streaming
    # was removed in favor of paragraph-wise streaming in the Rust ws
    # layer (each paragraph → one /v1/audio/speech call). The field stays
    # for wire compatibility but only "audio" is accepted.
    stream_format: str = Field(default="audio", pattern=r"^audio$")
    x_companion: XCompanion = Field(default_factory=XCompanion)


# ── Engine state ───────────────────────────────────────────────────────

class State:
    engine: object = None  # Qwen3TTSEngine, set on startup
    voices_config_path: Optional[Path] = None
    voice_configs: dict[str, dict] = {}
    ready: bool = False
    cold_start_error: Optional[str] = None


state = State()


def _load_voices_config(path: Path) -> dict[str, dict]:
    """Parse a voices.toml file. Returns voice_id -> config dict."""
    if not path.exists():
        return {}
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for entry in raw.get("voice", []):
        vid = entry.get("id")
        if not vid:
            continue
        out[vid] = entry
    return out


# ── Audio encoding helpers ─────────────────────────────────────────────

def _wav_bytes(wave_f32: np.ndarray, sample_rate: int) -> bytes:
    """Encode float32 mono wave to WAV bytes."""
    buf = io.BytesIO()
    sf.write(buf, wave_f32, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ── Lifecycle ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load engine and register voices.
    model_dir = os.environ.get("TTS_MODEL_DIR")
    if not model_dir:
        state.cold_start_error = "TTS_MODEL_DIR not set"
        yield
        return

    attn = os.environ.get("TTS_ATTN_IMPL", "auto")
    dtype = os.environ.get("TTS_DTYPE", "bf16")

    try:
        from qwen3_engine import Qwen3TTSEngine  # type: ignore
        print(f"[qwen3-sidecar] loading model from {model_dir}", flush=True)
        state.engine = Qwen3TTSEngine(model_dir=model_dir, attn=attn, dtype=dtype)
        print(f"[qwen3-sidecar] engine loaded, attn_impl={state.engine.attn_impl}", flush=True)

        # Voice registration
        voices_path = os.environ.get("TTS_VOICES_CONFIG")
        if voices_path:
            p = Path(voices_path)
            state.voices_config_path = p
            state.voice_configs = _load_voices_config(p)
            for vid, vcfg in state.voice_configs.items():
                ref = vcfg.get("reference_audio")
                if not ref:
                    print(f"[qwen3-sidecar] voice {vid} has no reference_audio, skipping",
                          file=sys.stderr, flush=True)
                    continue
                lang = vcfg.get("language", "ja")
                rtext = vcfg.get("reference_text")
                print(f"[qwen3-sidecar] registering voice id={vid} ref={Path(ref).name}", flush=True)
                state.engine.register_voice(
                    voice_id=vid, reference_audio=ref,
                    reference_language=lang, reference_text=rtext,
                )

        state.ready = True
        print(f"[qwen3-sidecar] READY on port {os.environ.get('TTS_PORT', '?')}", flush=True)
    except Exception as e:
        state.cold_start_error = f"{type(e).__name__}: {e}"
        print(f"[qwen3-sidecar] startup error: {state.cold_start_error}", file=sys.stderr, flush=True)
        import traceback; traceback.print_exc(file=sys.stderr)
    yield
    # Shutdown — nothing to do (CUDA cleanup happens when interpreter exits)
    print(f"[qwen3-sidecar] shutting down", flush=True)


app = FastAPI(lifespan=lifespan, title="Qwen3-TTS Sidecar",
              version=f"spec-v{SPEC_VERSION}")

# CORS — allow the companion-server frontend (default http://127.0.0.1:9181)
# to fetch /v1/audio/voices from the Settings page. The sidecar binds to
# 127.0.0.1 so this is loopback-only; we restrict origins to localhost
# variants rather than '*' to keep the surface tight.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_spec_version(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-TTS-Provider-Spec"] = SPEC_VERSION
    return resp


# ── Routes ─────────────────────────────────────────────────────────────

@app.get("/healthz")
async def healthz():
    if state.cold_start_error:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "engine": ENGINE_ID,
                     "error": state.cold_start_error}
        )
    if not state.ready:
        return JSONResponse(
            status_code=503,
            content={"status": "warming", "engine": ENGINE_ID}
        )
    return {"status": "ok", "engine": ENGINE_ID,
            "voices_ready": len(state.voice_configs),
            "attn_impl": getattr(state.engine, "attn_impl", "?")}


# Legacy GET /health alias for the existing Rust supervisor
@app.get("/health")
async def health_legacy():
    return await healthz()


@app.get("/v1/audio/voices")
async def list_voices():
    if not state.ready:
        raise HTTPException(503, detail="engine warming up")
    voices = state.engine.list_voices()
    for v in voices:
        v["name"] = state.voice_configs.get(v["id"], {}).get("name", v["id"])
        v["engine"] = ENGINE_ID
    return {"voices": voices}


@app.post("/v1/audio/voices/clone")
async def clone_voice(
    wav_file: UploadFile = File(...),
    name: str = Form(...),
    language: str = Form("ja"),
    reference_text: Optional[str] = Form(None),
):
    if not state.ready:
        raise HTTPException(503, detail="engine warming up")
    if not re.fullmatch(r"[a-zA-Z0-9_\-]+", name):
        raise HTTPException(400, detail="invalid voice name (use [a-zA-Z0-9_-]+)")

    # Persist the upload to disk so the engine can re-read it (and so
    # the registration survives sidecar restart if we add manifest persist)
    voices_dir = Path(os.environ.get("TTS_CLONED_VOICES_DIR", str(THIS_DIR / "cloned_voices")))
    voices_dir.mkdir(parents=True, exist_ok=True)
    dest = voices_dir / f"{name}.wav"
    content = await wav_file.read()
    dest.write_bytes(content)

    state.engine.register_voice(
        voice_id=name, reference_audio=str(dest),
        reference_language=language, reference_text=reference_text,
    )
    state.voice_configs[name] = {
        "id": name, "name": name, "language": language,
        "reference_audio": str(dest), "reference_text": reference_text,
    }
    return {"voice_id": name, "engine": ENGINE_ID, "ready": True}


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if not state.ready:
        raise HTTPException(503, detail="engine warming up")
    if req.response_format not in SUPPORTED_FORMATS:
        raise HTTPException(400, detail=f"response_format must be one of {SUPPORTED_FORMATS}")

    voice_id = req.voice
    if voice_id not in state.voice_configs:
        # Fall back to x_companion.reference_id
        rid = req.x_companion.reference_id
        if rid and rid in state.voice_configs:
            voice_id = rid
        else:
            raise HTTPException(404, detail=f"unknown voice: {req.voice}")

    # Language: explicit override, else voice's native, else default
    voice_cfg = state.voice_configs[voice_id]
    language = (req.x_companion.language
                or voice_cfg.get("language", "ja"))

    quality = req.x_companion.quality or "balanced"
    advanced = req.x_companion.advanced

    # Only the blocking audio path is supported. Pydantic's regex on
    # SpeechRequest.stream_format already rejects anything other than
    # "audio" with a 422, so we don't need a branch here.
    try:
        sr, wave_f32 = await asyncio.to_thread(
            state.engine.synthesize,
            text=req.input,
            voice_id=voice_id,
            language=language,
            quality=quality,
            advanced=advanced,
        )
    except KeyError as e:
        raise HTTPException(404, detail=str(e))
    except ValueError as e:
        raise HTTPException(400, detail=str(e))
    body = _wav_bytes(wave_f32, sr)
    headers = {
        "X-Sample-Rate": str(sr),
        "X-Channels": "1",
        "X-Format": "wav",
    }
    return Response(content=body, media_type="audio/wav", headers=headers)


# Legacy POST /tts (existing companion contract) — translate to /v1/audio/speech.
# Lets the rust side migrate at its own pace.
@app.post("/tts")
async def legacy_tts(req: Request):
    body = await req.json()
    spec_req = SpeechRequest(
        input=body.get("text", ""),
        voice=body.get("voice") or next(iter(state.voice_configs), "asuna"),
        speed=float(body.get("speed", 1.0)),
        x_companion=XCompanion(language=body.get("language", "ja"),
                                quality=body.get("quality", "balanced")),
    )
    return await speech(spec_req)


@app.post("/shutdown")
async def shutdown():
    """Graceful shutdown for the existing supervisor."""
    import threading, signal
    def _quit():
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Timer(0.5, _quit).start()
    return {"status": "shutting_down"}


def main():
    port = int(os.environ.get("TTS_PORT", "9890"))
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    uvicorn.run(
        app, host=host, port=port,
        log_level=os.environ.get("TTS_LOG_LEVEL", "info"),
        access_log=False,
    )


if __name__ == "__main__":
    main()
