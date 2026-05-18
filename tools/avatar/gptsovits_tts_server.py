"""HTTP server speaking the waifu-companion avatar TTS port contract,
backed by `gptsovits_engine.GPTSoVITSEngine`.

Wire contract (model-agnostic — every TTS engine wrapper must conform):

    POST /tts        {"text": "...", "language": "ja",
                      "voice": "...", "speed": 1.0,
                      "sample_steps": int?}
                  -> WAV bytes (X-Sample-Rate / X-Channels / X-Format headers)
    GET  /health  -> 200 OK once the engine is loaded
    POST /shutdown — graceful exit (companion-server hits this on app close;
                     skipping it leaves the CUDA context warm and tanks
                     post-close gaming performance for ~30-90 s).

Configuration is via env vars; see `EngineConfig.from_env` for the
schema. Companion forwards them from [avatar.tts]; for standalone use
set them yourself before launching.

Run:

    python tools/avatar/gptsovits_tts_server.py
"""

from __future__ import annotations

import atexit
import io
import os
import signal
import sys
import threading
import time
import wave
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import uvicorn

# Importing the engine module runs the env-knob preamble before torch
# loads. Do not import torch before this.
from gptsovits_engine import EngineConfig, GPTSoVITSEngine

# `librosa.effects.time_stretch` is only needed when speed != 1.0; defer
# the (slow) import to the request that actually wants it.

# ---------------------------------------------------------------------------
# Request schema
# ---------------------------------------------------------------------------


class TtsRequest(BaseModel):
    text: str
    language: Optional[str] = None    # falls back to engine default
    voice: Optional[str] = None       # informational; engine is single-voice
    speed: float = 1.0
    # Per-request override for CFM rectified-flow steps. None → use the
    # server-wide default. Lower = faster, rougher; higher = slower,
    # smoother. Useful for A/B at different step counts without restart.
    sample_steps: Optional[int] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _wav_bytes(audio_f32: np.ndarray, sr: int) -> bytes:
    audio_i16 = np.clip(audio_f32, -1.0, 1.0)
    audio_i16 = (audio_i16 * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(audio_i16.tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def build_app(engine: GPTSoVITSEngine) -> FastAPI:
    app = FastAPI(title="gpt-sovits-tts")

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "engine": "gpt-sovits-v4",
            "voices": [engine.config.default_voice],
            "languages": ["ja", "en", "zh"],
            "default_voice": engine.config.default_voice,
            "default_language": engine.config.default_language,
            "sample_rate": engine.OUTPUT_SAMPLE_RATE,
            "ar_backend": engine.ar_backend_name,
            "cfm_sample_steps": engine.config.cfm_sample_steps,
        }

    @app.post("/tts")
    async def tts(req: TtsRequest):
        if not req.text or not req.text.strip():
            raise HTTPException(400, "text must not be empty")
        lang = req.language or engine.config.default_language
        # Accept every GPT-SoVITS v4 supported language. The text
        # cleaner in clean_text() routes to the right phonemizer per
        # language code (japanese, english, chinese2, korean, cantonese).
        if lang not in ("ja", "en", "zh", "ko", "yue"):
            raise HTTPException(400, f"unsupported language: {lang}")

        t0 = time.time()
        try:
            steps = max(4, int(req.sample_steps)) if req.sample_steps is not None else None
            audio = engine.synthesize(req.text, lang, sample_steps=steps)
        except Exception as e:
            import traceback
            traceback.print_exc()
            raise HTTPException(500, f"synthesis failed: {e}") from e

        if abs(req.speed - 1.0) > 1e-3:
            import librosa  # lazy: heavy import; only some callers need it
            audio = librosa.effects.time_stretch(audio, rate=req.speed)

        wav = _wav_bytes(audio, engine.OUTPUT_SAMPLE_RATE)
        duration = len(audio) / engine.OUTPUT_SAMPLE_RATE
        print(
            f"[gpt-sovits-tts] /tts lang={lang} chars={len(req.text)} "
            f"audio={duration:.2f}s wall={time.time() - t0:.2f}s"
        )
        return Response(
            content=wav,
            media_type="audio/wav",
            headers={
                "X-Sample-Rate": str(engine.OUTPUT_SAMPLE_RATE),
                "X-Channels": "1",
                "X-Format": "wav",
            },
        )

    @app.post("/shutdown")
    async def shutdown():
        """Graceful shutdown. Companion-server hits this when the user
        closes the desktop app. Returns immediately; the actual exit
        happens on a daemon thread after a short delay so the response
        can flush."""
        def _exit_soon():
            time.sleep(0.2)
            engine.shutdown()
            # `os._exit` avoids uvicorn's graceful-TCP-close stall,
            # which would otherwise delay the GPU release we just did.
            os._exit(0)
        threading.Thread(target=_exit_soon, daemon=True).start()
        return {"status": "shutting_down"}

    return app


# ---------------------------------------------------------------------------
# Process lifecycle
# ---------------------------------------------------------------------------


def _install_signal_handlers(engine: GPTSoVITSEngine) -> None:
    """Catch Ctrl+C (SIGINT) and Ctrl+Break (SIGBREAK on Windows). For
    headless launches via Tauri sidecar the /shutdown endpoint is the
    primary path; signal handlers cover console use + emergencies."""
    def _on_signal(sig, _frame):
        print(f"[gpt-sovits-tts] received signal {sig}; cleaning up")
        engine.shutdown()
        os._exit(0)

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, _on_signal)
    atexit.register(engine.shutdown)


def main() -> None:
    if os.environ.get("PYTORCH_NO_CUDA_MEMORY_CACHING") == "1":
        print("[gpt-sovits-tts] CUDA caching DISABLED (slower; explicit env var)")
    else:
        print("[gpt-sovits-tts] CUDA caching ON (default — ~2x faster inference)")

    port = int(os.environ.get("TTS_PORT", "9880"))
    skip_warmup = os.environ.get("TTS_NO_WARMUP") == "1"

    config = EngineConfig.from_env()
    print(f"[gpt-sovits-tts] CFM sample_steps={config.cfm_sample_steps}")
    engine = GPTSoVITSEngine(config)
    _install_signal_handlers(engine)
    if skip_warmup:
        print("[gpt-sovits-tts] warmup skipped (TTS_NO_WARMUP=1)")
    else:
        engine.warmup()

    app = build_app(engine)
    print(f"[gpt-sovits-tts] serving on http://127.0.0.1:{port}")
    try:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    finally:
        # Defense in depth: if uvicorn returns normally (no signal, no
        # /shutdown), still release the GPU.
        engine.shutdown()


if __name__ == "__main__":
    main()
