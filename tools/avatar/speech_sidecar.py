"""Speech sidecar — single Whisper instance serving both voice-input
(ASR for the user's mic) and TTS verification (post-synthesis content
checking).

Two callers:

  - **Voice input** (planned UI feature): the avatar page captures
    mic audio and POSTs it here for transcription. `POST /asr` is the
    public wire contract.

  - **TTS verification**: the GPT-SoVITS wrapper calls `POST /asr`
    with the audio it just synthesized, compares the transcript to
    the input text, and re-rolls if they don't match. Catches the
    three AR failure modes that duration heuristics can't:
      1. Early-stop — transcript shorter than input
      2. Loop — transcript contains duplicated content
      3. Drift — transcript ≠ input semantically

Wire shape (mirrors the TTS / NMT sidecars):

    GET  /health    -> {status, backend, model_size, version}
    POST /asr       {audio: base64-wav, language?: str, prompt?: str}
                    -> {text: str, language: str, duration: float,
                        segments: [{start, end, text}]}
    POST /shutdown  -> graceful exit (companion-server's close path)

Env config (matches the TTS pattern — companion-server forwards these
when spawning):

    SPEECH_PORT          — bind port, default 9882
    SPEECH_MODEL_SIZE    — "tiny" | "base" | "small" | "medium" |
                           "large-v3" | "distil-large-v3", default "small"
    SPEECH_DEVICE        — "cpu" | "cuda" | "cuda:0", default cuda if avail
    SPEECH_COMPUTE_TYPE  — "int8" | "int8_float16" | "float16" | "float32"
                           default int8_float16 on GPU, int8 on CPU
    SPEECH_DEFAULT_LANG  — preferred decode hint, default unset (auto)

Run:
    python tools/avatar/speech_sidecar.py
"""

from __future__ import annotations

import base64
import io
import os
import signal
import sys
import threading
import time
import wave
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn

# Stdout / stderr UTF-8 — Windows console cp1252 chokes on Japanese
# segment text from Whisper.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Defer the heavy import to first use — Whisper pulls in torch + onnx
# transitively (~800ms cold). HTTP /health stays cheap.
_whisper_model = None
_whisper_lock = threading.Lock()


def _load_model():
    """Lazy-load Whisper. Idempotent + thread-safe."""
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    with _whisper_lock:
        if _whisper_model is not None:
            return _whisper_model
        from faster_whisper import WhisperModel
        size = os.environ.get("SPEECH_MODEL_SIZE", "small")
        device = os.environ.get("SPEECH_DEVICE")
        if not device:
            # Auto-detect: prefer cuda when available.
            try:
                import torch
                device = "cuda" if torch.cuda.is_available() else "cpu"
            except ImportError:
                device = "cpu"
        compute_type = os.environ.get("SPEECH_COMPUTE_TYPE")
        if not compute_type:
            compute_type = "int8_float16" if device.startswith("cuda") else "int8"
        print(
            f"[speech-sidecar] loading faster-whisper {size!r} "
            f"(device={device!r}, compute_type={compute_type!r})...",
            flush=True,
        )
        t0 = time.time()
        _whisper_model = WhisperModel(size, device=device, compute_type=compute_type)
        print(
            f"[speech-sidecar] model loaded in {time.time()-t0:.2f}s",
            flush=True,
        )
        return _whisper_model


# ---------------------------------------------------------------------
# Wire shapes
# ---------------------------------------------------------------------

class ASRRequest(BaseModel):
    """`audio` is a base64-encoded WAV/PCM (any sample rate; we resample
    via Whisper's own preprocessor). Frontend may also send Float32 raw
    samples + a sample_rate field as a future extension."""
    audio: str
    language: Optional[str] = None  # ISO-2 code; None → auto-detect
    prompt: Optional[str] = None    # initial-prompt context (Whisper hint)
    # Per-call opt-in for word-level timestamps. Off by default (saves
    # ~30% wall on each request). The TTS loop-trim path turns this on
    # to find word boundaries inside Whisper's VAD-grouped segments —
    # essential when AR loops produce continuous speech that VAD treats
    # as a single segment.
    word_timestamps: Optional[bool] = False


class WordOut(BaseModel):
    start: float
    end: float
    word: str


class SegmentOut(BaseModel):
    start: float
    end: float
    text: str
    # Per-word timing — populated only when the request set
    # `word_timestamps=True`. The TTS loop-trim path needs this to
    # find a clean cut inside a long VAD-grouped segment.
    words: Optional[list[WordOut]] = None


class ASRResponse(BaseModel):
    text: str
    language: str
    duration: float           # seconds of input audio
    wall_ms: float            # how long Whisper took to transcribe
    segments: list[SegmentOut]


def make_app() -> FastAPI:
    app = FastAPI(title="waifu-companion speech sidecar", version="1.0.0")

    @app.get("/health")
    async def health():
        # Don't force-load Whisper here — keep /health cheap so the
        # companion's watchdog doesn't trigger a multi-second model
        # load every probe.
        return {
            "status": "ok",
            "backend": "faster-whisper",
            "model_size": os.environ.get("SPEECH_MODEL_SIZE", "small"),
            "version": "1.0.0",
            "model_loaded": _whisper_model is not None,
        }

    @app.post("/asr", response_model=ASRResponse)
    async def asr(req: ASRRequest):
        # Decode audio
        try:
            wav_bytes = base64.b64decode(req.audio)
        except Exception as e:
            raise HTTPException(400, f"bad base64 audio: {e}")
        if not wav_bytes:
            raise HTTPException(400, "empty audio")

        # Measure duration up front so callers can log it even on
        # transcript errors.
        try:
            with wave.open(io.BytesIO(wav_bytes), "rb") as w:
                duration = w.getnframes() / max(1, w.getframerate())
        except Exception:
            duration = 0.0

        try:
            model = _load_model()
        except Exception as e:
            raise HTTPException(500, f"model load failed: {e}")

        t0 = time.time()
        # faster-whisper expects a path or an array. Write to a temp
        # file via io to avoid an actual disk write — its transcribe()
        # accepts a file-like object with read+seek.
        try:
            segments_iter, info = model.transcribe(
                io.BytesIO(wav_bytes),
                language=req.language,
                initial_prompt=req.prompt,
                # Word-level timestamps are opt-in (saves ~30% wall on
                # the common verify-only path). The TTS loop-trim flow
                # turns it on so it can find word boundaries inside
                # long VAD-grouped segments.
                word_timestamps=bool(req.word_timestamps),
                # Reduce hallucination on quiet/empty audio (Whisper's
                # weakness — likes to invent transcripts for silence).
                no_speech_threshold=0.6,
                vad_filter=True,
            )
        except Exception as e:
            raise HTTPException(500, f"transcribe failed: {e}")

        segments_list: list[SegmentOut] = []
        text_parts: list[str] = []
        for s in segments_iter:
            words_out: Optional[list[WordOut]] = None
            seg_words = getattr(s, "words", None)
            if req.word_timestamps and seg_words:
                words_out = [
                    WordOut(start=w.start, end=w.end, word=w.word)
                    for w in seg_words
                ]
            segments_list.append(SegmentOut(
                start=s.start, end=s.end, text=s.text, words=words_out,
            ))
            text_parts.append(s.text)
        full_text = "".join(text_parts).strip()
        wall_ms = (time.time() - t0) * 1000.0
        print(
            f"[speech-sidecar] /asr lang={info.language!r} "
            f"dur={duration:.2f}s wall={wall_ms:.0f}ms "
            f"chars={len(full_text)}",
            flush=True,
        )
        return ASRResponse(
            text=full_text,
            language=info.language or req.language or "unknown",
            duration=duration,
            wall_ms=wall_ms,
            segments=segments_list,
        )

    @app.post("/shutdown")
    async def shutdown():
        """Graceful exit — companion-server's close-with-companion hits
        this. Daemon thread does the actual os._exit so the HTTP
        response can flush first."""
        def _exit_soon():
            time.sleep(0.2)
            print("[speech-sidecar] shutting down")
            os._exit(0)
        threading.Thread(target=_exit_soon, daemon=True).start()
        return {"status": "shutting_down"}

    return app


def _install_signal_handlers() -> None:
    def _on_signal(sig, _frame):
        print(f"[speech-sidecar] received signal {sig}; exiting", flush=True)
        os._exit(0)
    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, _on_signal)


def main() -> None:
    _install_signal_handlers()
    port = int(os.environ.get("SPEECH_PORT", "9882"))
    app = make_app()
    if os.environ.get("SPEECH_WARMUP", "1") == "1":
        # Optional warm-up: load the model so the first /asr request
        # doesn't pay the load cost. Comment out for fast boot in
        # transient test runs.
        try:
            _load_model()
        except Exception as e:
            print(f"[speech-sidecar] warmup load failed: {e}", flush=True)
    print(f"[speech-sidecar] serving on http://127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
