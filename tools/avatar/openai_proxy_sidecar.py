"""OpenAI-TTS proxy sidecar — implements TTS-PROVIDER-SPEC v1 by forwarding
to api.openai.com/v1/audio/speech.

Demonstrates that the spec is real: same Rust client, different sidecar,
no companion-side changes required. Useful as:

  - A no-GPU fallback when local Qwen3-TTS isn't viable.
  - A smoke test for the abstraction (Day-5 milestone in the port plan).

Required env vars:
  TTS_PORT         — port to bind (default 9890)
  OPENAI_API_KEY   — OpenAI key (required)
  OPENAI_BASE_URL  — override the API host (default https://api.openai.com)
  TTS_OPENAI_MODEL — default model when client doesn't specify
                     (default "tts-1"; use "tts-1-hd" for high preset)
"""
from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

for s in (sys.stdout, sys.stderr):
    try: s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass


SPEC_VERSION = "1"
ENGINE_ID = "openai-tts"
OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
DEFAULT_MODEL = os.environ.get("TTS_OPENAI_MODEL", "tts-1")


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
    response_format: str = Field(default="wav", pattern=r"^(wav|mp3|opus|aac|flac|pcm)$")
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    stream_format: str = Field(default="audio")
    x_companion: XCompanion = Field(default_factory=XCompanion)


class State:
    api_key: Optional[str] = None
    base_url: str = "https://api.openai.com"
    client: Optional[httpx.AsyncClient] = None
    ready: bool = False


state = State()


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.api_key = os.environ.get("OPENAI_API_KEY")
    state.base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com").rstrip("/")
    if not state.api_key:
        print("[openai-proxy] WARNING: OPENAI_API_KEY not set; /healthz will return 503",
              file=sys.stderr, flush=True)
    state.client = httpx.AsyncClient(timeout=60.0)
    state.ready = state.api_key is not None
    print(f"[openai-proxy] READY on port {os.environ.get('TTS_PORT', '?')} "
          f"(model={DEFAULT_MODEL}, base_url={state.base_url})", flush=True)
    yield
    await state.client.aclose()


app = FastAPI(lifespan=lifespan, title="OpenAI-TTS Proxy",
              version=f"spec-v{SPEC_VERSION}")

# CORS — same loopback-only policy as qwen3_tts_sidecar so the
# Settings page can fetch /v1/audio/voices for the dropdown.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_spec_version(request, call_next):
    resp = await call_next(request)
    resp.headers["X-TTS-Provider-Spec"] = SPEC_VERSION
    return resp


@app.get("/healthz")
async def healthz():
    if not state.ready:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "engine": ENGINE_ID,
                     "error": "OPENAI_API_KEY not set"}
        )
    return {"status": "ok", "engine": ENGINE_ID, "voices_ready": len(OPENAI_VOICES)}


@app.get("/health")
async def health_legacy():
    return await healthz()


@app.get("/v1/audio/voices")
async def list_voices():
    return {
        "voices": [
            {"id": v, "name": v.capitalize(), "language": None,
             "engine": ENGINE_ID, "cloned": False}
            for v in OPENAI_VOICES
        ]
    }


@app.post("/v1/audio/voices/clone")
async def clone_voice(
    wav_file: UploadFile = File(...),
    name: str = Form(...),
    language: str = Form("en"),
    reference_text: Optional[str] = Form(None),
):
    # OpenAI's API doesn't expose voice cloning; document the limit.
    raise HTTPException(
        status_code=501,
        detail="openai-tts does not support voice cloning. Use a different backend "
               "(e.g. qwen3-tts-1.7b) for cloned voices."
    )


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if not state.ready:
        raise HTTPException(503, detail="OPENAI_API_KEY not set")
    if req.voice not in OPENAI_VOICES:
        raise HTTPException(404, detail=f"unknown voice: {req.voice}. Available: {OPENAI_VOICES}")

    # Map x_companion.quality to OpenAI model tier
    quality = req.x_companion.quality or "balanced"
    model = req.model or (
        "tts-1-hd" if quality == "high" else "tts-1"
    )

    # OpenAI's API: minimal body, no language param (it infers).
    openai_body = {
        "model": model,
        "input": req.input,
        "voice": req.voice,
        "response_format": req.response_format,
        "speed": req.speed,
    }
    headers = {
        "Authorization": f"Bearer {state.api_key}",
        "Content-Type": "application/json",
    }

    upstream = await state.client.post(
        f"{state.base_url}/v1/audio/speech",
        json=openai_body, headers=headers,
    )
    if upstream.status_code != 200:
        raise HTTPException(
            status_code=upstream.status_code,
            detail=upstream.text[:500],
        )

    fmt = req.response_format
    content_type = {
        "wav": "audio/wav", "mp3": "audio/mpeg", "opus": "audio/opus",
        "aac": "audio/aac", "flac": "audio/flac", "pcm": "audio/pcm",
    }.get(fmt, "audio/wav")

    return Response(
        content=upstream.content,
        media_type=content_type,
        headers={
            # OpenAI doesn't expose sample rate; default 24kHz mono.
            "X-Sample-Rate": "24000",
            "X-Channels": "1",
            "X-Format": fmt,
        },
    )


@app.post("/shutdown")
async def shutdown():
    import os, signal, threading
    threading.Timer(0.5, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
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
