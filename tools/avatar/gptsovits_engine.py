"""GPT-SoVITS v4 zero-shot synthesis engine.

The model side of the companion's TTS port. Owns model loading,
reference clip caching, text segmentation, synthesis (with AR
backend selection between the naive Python loop and the CUDA-graph
runner), warmup, and graceful shutdown.

Knows nothing about HTTP. The companion's `tools/avatar/gptsovits_tts_server.py`
wraps an instance in a FastAPI app and speaks the avatar TTS contract;
dev tooling can import this module directly to synthesize without
spawning a server.

Typical use:

    from gptsovits_engine import EngineConfig, GPTSoVITSEngine

    engine = GPTSoVITSEngine(EngineConfig.from_env())
    engine.warmup()
    audio = engine.synthesize("こんにちは", "ja")

Module-level side effects: this file sets a small set of env vars
(CUDA_MODULE_LOADING, HF_HUB_OFFLINE, …) at import time so they land
before `import torch` here picks them up. Importing the module does
NOT load any models — that happens in `GPTSoVITSEngine.__init__`.
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Protocol

# ---------------------------------------------------------------------------
# Import-time environment setup.
#
# These have to be configured BEFORE torch / transformers are imported,
# or they're no-ops:
#   * CUDA_MODULE_LOADING=LAZY  — CUDA reads it once at first init.
#   * HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE — read at `from_pretrained`.
#   * stdout/stderr reconfigure — Windows cp1252 + Python logging will
#                                 crash on em-dashes printed by the wrapper
#                                 if we don't flip them to utf-8 first.
# Keeping them module-level means any importer (server, dev script)
# gets them automatically before they trigger torch import.
# ---------------------------------------------------------------------------

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

os.environ.setdefault("CUDA_MODULE_LOADING", "LAZY")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

# When companion-server spawns us via Tauri's sidecar, the parent's PATH
# does NOT include the conda env's Scripts/ dir, so subprocesses
# (notably ffmpeg, called by GPT-SoVITS' load_audio for reference clip
# decoding) fail with "WinError 2: cannot find the file specified".
# Activating conda's hooks at runtime is fragile; we just prepend the
# env's Scripts + Library/bin (where conda installs Windows binaries) to
# PATH unconditionally — harmless if they're already there.
_env_root = os.path.dirname(sys.executable)
for _bindir in (
    os.path.join(_env_root, "Scripts"),
    os.path.join(_env_root, "Library", "bin"),
    os.path.join(_env_root, "Library", "mingw-w64", "bin"),
    os.path.join(_env_root, "Library", "usr", "bin"),
):
    if os.path.isdir(_bindir):
        os.environ["PATH"] = _bindir + os.pathsep + os.environ.get("PATH", "")

import numpy as np  # noqa: E402
import torch  # noqa: E402

# - cudnn.benchmark = FALSE. It autotunes conv algorithms per *input shape*
#   — a win only when the same shapes recur. TTS text length varies, so
#   shapes never repeat and `benchmark=True` pays a ~15-20s autotune sweep
#   on *every* /tts request. With it off, cuDNN picks a fast heuristic
#   algorithm with no autotune. Override with TTS_CUDNN_BENCHMARK=1 if your
#   usage really is fixed-shape.
# - allow_tf32 lets the matmul + cuDNN pipelines use TF32 on Ampere+. The
#   fp16 hot paths bypass it; a few helper fp32 ops benefit.
torch.backends.cudnn.benchmark = os.environ.get("TTS_CUDNN_BENCHMARK") == "1"
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

OUTPUT_SAMPLE_RATE = 48_000  # GPT-SoVITS v4 vocoder output rate


@dataclass
class EngineConfig:
    """All inputs the engine needs. Build via `from_env()` for the
    standard companion-driven launch, or construct directly for tests."""

    model_path: Path                  # GPT-SoVITS install root
    reference_audio: Path             # 3-10s clip of the target voice
    reference_text: str               # Transcript of the reference clip
    reference_language: str = "ja"    # Language of the reference clip
    default_voice: str = "default"
    default_language: str = "ja"
    # Fine-tune name prefix used to pick checkpoints from
    # SoVITS_weights_v4/ and GPT_weights_v3/. Empty = first ckpt found.
    lora_prefix: str = ""
    # CFM rectified-flow ODE steps. 16 is generally inaudibly indistinguishable
    # from the 32-step default on short utterances; lower if you need more speed
    # and have verified the audible floor.
    cfm_sample_steps: int = 16
    # AR backend: True selects the CUDA-graph runner (graph capture + replay),
    # False uses the canonical Text2SemanticLightningModule.infer_panel_naive
    # Python loop. Cuda-graph is ~20-30% faster per token on RTX 30/40/50 class
    # GPUs; same weights, same SDPA math, statistically equivalent output.
    use_cuda_graph: bool = False
    gpu_device: int = 0               # -1 for CPU
    # Optional: explicit path to a folder containing ffmpeg.exe to prepend
    # to PATH. The conda-env auto-prepend usually finds it.
    ffmpeg_bin: Optional[Path] = None

    @classmethod
    def from_env(cls) -> "EngineConfig":
        """Mirror what companion's AnimeTtsManager forwards via env vars
        (see crates/companion-avatar/src/tts_server.rs::start_server)."""
        model_path = os.environ.get("TTS_MODEL_PATH")
        if not model_path:
            raise SystemExit(
                "TTS_MODEL_PATH env var not set. Point it at your GPT-SoVITS "
                "checkout root, or set [avatar.tts] model_path in companion.toml."
            )
        ref_audio = os.environ.get("TTS_REFERENCE_AUDIO")
        ref_text = os.environ.get("TTS_REFERENCE_TEXT")
        if not ref_audio or not ref_text:
            raise SystemExit(
                "GPT-SoVITS zero-shot needs a reference clip. Set TTS_REFERENCE_AUDIO "
                "to a 3-10s WAV of the target voice and TTS_REFERENCE_TEXT to its "
                "transcript (or configure [avatar.tts] reference_audio/reference_text "
                "in companion.toml)."
            )
        try:
            cfm_steps = max(4, int(os.environ.get("TTS_CFM_STEPS", "16")))
        except ValueError:
            cfm_steps = 16
        try:
            gpu_device = int(os.environ.get("CUDA_VISIBLE_DEVICES", "0"))
        except ValueError:
            gpu_device = 0
        ffmpeg = os.environ.get("TTS_FFMPEG_BIN")
        return cls(
            model_path=Path(model_path).resolve(),
            reference_audio=Path(ref_audio),
            reference_text=ref_text,
            reference_language=os.environ.get("TTS_REFERENCE_LANG", "ja"),
            default_voice=os.environ.get("TTS_VOICE", "default"),
            default_language=os.environ.get("TTS_LANGUAGE", "ja"),
            lora_prefix=(
                os.environ.get("TTS_LORA_NAME")
                or os.environ.get("TTS_VOICE")
                or ""
            ),
            cfm_sample_steps=cfm_steps,
            use_cuda_graph=os.environ.get("TTS_USE_CUDAGRAPH") == "1",
            gpu_device=gpu_device,
            ffmpeg_bin=Path(ffmpeg) if ffmpeg else None,
        )


# ---------------------------------------------------------------------------
# Text segmentation.
#
# GPT-SoVITS' AR (text→semantic) model is trained on single utterances.
# Feed it a whole multi-sentence reply in one shot and it frequently
# predicts EOS early — you get audio for the first sentence and the rest
# is silently dropped (the "she only said 4 words" symptom). A stray digit
# or unusual symbol makes it worse. The official UI cuts text into short
# segments, synthesizes each, and concatenates the audio.
#
# Per-single-sentence cutting hurts prosody — the model handles
# inter-sentence rhythm noticeably better given a few sentences of
# context. So we cut into ~2-3-sentence segments (lang-aware char target)
# and rely on the re-roll in `_synthesize_robust` to catch the occasional
# early-stop. A runaway terminator-less "sentence" is sub-split on
# commas; failing that, hard-cut.
# ---------------------------------------------------------------------------

_SENT_END = set("。！？!?…．")               # CJK + ASCII terminators
_TRAILERS = set("\"'）)]}」』】〉》”’～~ ")   # Closing punct that rides on prev sentence
_SOFT_BREAK = set("、，,；;：:")              # Soft breakpoints for over-long runs

_HARD_SENTENCE_CAP = 90                # Force a break past this with no terminator
_SEG_TARGET_CHARS_CJK = 36
_SEG_MAX_CHARS_CJK = 70
_SEG_TARGET_CHARS_LATIN = 120
_SEG_MAX_CHARS_LATIN = 240

SEG_GAP_SECONDS = 0.10                 # Inter-segment silence to avoid jamming


def _has_speakable(s: str) -> bool:
    return any(c.isalnum() or "぀" <= c <= "ヿ" or "一" <= c <= "鿿" for c in s)


def _has_cjk(s: str) -> bool:
    return any("぀" <= c <= "ヿ" or "一" <= c <= "鿿" for c in s)


def split_sentences(text: str) -> list[str]:
    """Split `text` into individual sentences (terminator kept attached;
    pure-punctuation fragments dropped)."""
    text = text.strip()
    if not text:
        return []
    out: list[str] = []
    buf: list[str] = []
    pending_cut = False

    def flush():
        nonlocal pending_cut
        pending_cut = False
        s = "".join(buf).strip()
        buf.clear()
        if s and _has_speakable(s):
            out.append(s)

    last_soft = -1
    for ch in text:
        if ch == "\n":
            flush()
            last_soft = -1
            continue
        if pending_cut and ch not in _TRAILERS and ch not in _SENT_END:
            flush()
            last_soft = -1
        buf.append(ch)
        if ch in _SOFT_BREAK:
            last_soft = len(buf)
        if ch in _SENT_END:
            pending_cut = True
        elif len(buf) >= _HARD_SENTENCE_CAP and not pending_cut:
            if 0 < last_soft < len(buf):
                head, tail = buf[:last_soft], buf[last_soft:]
                buf[:] = head
                flush()
                buf.extend(tail)
            else:
                flush()
            last_soft = -1
    flush()
    return out


def split_for_tts(text: str, lang: str) -> list[str]:
    """Group `split_sentences` output into AR-safe segments.

    **CJK targets (ja / zh / ko)**: one segment per sentence. Empirically
    GPT-SoVITS v4's AR stochastically early-stops on multi-sentence
    inputs, dropping trailing sentences with audio that's just long
    enough to pass the floor check (user-observed 2026-05-14: "last
    sentence was lost in tts"). Per-sentence segments eliminate the
    AR-truncation footgun at a small prosody cost.

    **Latin targets**: keep the historical 2-3-sentence packing — AR
    handles English/Romance languages with longer context fine, and
    the prosody improvement from cross-sentence rhythm is audible.
    """
    sentences = split_sentences(text)
    if not sentences:
        return []
    cjk = lang in ("ja", "zh", "ko")
    if cjk:
        return sentences
    target = _SEG_TARGET_CHARS_LATIN
    hard = _SEG_MAX_CHARS_LATIN
    segs: list[str] = []
    cur = ""
    for s in sentences:
        if not cur:
            cur = s
        elif len(cur) >= target or len(cur) + 1 + len(s) > hard:
            segs.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}"
    if cur:
        segs.append(cur)
    return segs


# ---------------------------------------------------------------------------
# AR backends.
#
# The AR (text→semantic) decoder is the dominant ~60-70% of per-segment
# synth time. The Protocol below isolates that step so adding a third
# backend (e.g. ONNX, TensorRT, ggml) is a class addition, not a fork
# of the synth pipeline.
# ---------------------------------------------------------------------------


class ARBackend(Protocol):
    """Generate semantic tokens given phonemes + reference prompt.

    Returns a 1D LongTensor of generated tokens (excluding the reference
    prompt prefix). The caller wraps it as `[1, 1, N]` for the SoVITS
    decoder."""

    def generate(
        self,
        all_phone_ids: torch.Tensor,
        all_phone_lens: torch.Tensor,
        prompt_sem: torch.Tensor,
        all_bert: torch.Tensor,
        *,
        top_k: int,
        temperature: float,
        early_stop_num: int,
    ) -> torch.Tensor: ...


class NaiveARBackend:
    """Canonical Text2SemanticLightningModule + infer_panel_naive path.
    Python-level token-by-token loop; works on every PyTorch build."""

    def __init__(self, gpt_path: str, s1config: dict, device: torch.device):
        # Imports are local because they depend on GPT-SoVITS sys.path
        # manipulations done in the engine; importing them at module
        # level would couple this module to import order.
        from GPT_SoVITS.AR.models.t2s_lightning_module import (
            Text2SemanticLightningModule,
        )

        model = Text2SemanticLightningModule(s1config, Path("."), is_train=False)
        ckpt = torch.load(gpt_path, map_location="cpu", weights_only=False)["weight"]
        model.load_state_dict(ckpt, strict=False)
        model = model.half().to(device).eval()
        # The lightning module exposes both `infer_panel` and
        # `infer_panel_naive`. Pin the naive variant so we have a stable
        # call site and skip the kwargs-dispatch in the .infer_panel
        # wrapper.
        model.model.infer_panel = model.model.infer_panel_naive
        self._model = model

    def generate(self, all_phone_ids, all_phone_lens, prompt_sem, all_bert,
                 *, top_k, temperature, early_stop_num) -> torch.Tensor:
        gen = self._model.model.infer_panel(
            all_phone_ids, all_phone_lens, prompt_sem, all_bert,
            top_k=top_k, top_p=1, temperature=temperature,
            early_stop_num=early_stop_num,
        )
        y, idx = next(gen)
        return y[0, -idx:]  # [N] of generated tokens


class CudaGraphARBackend:
    """CUDA-graph runner: captures the per-token decode step once and
    replays it. Empirically 20-30% faster per token on consumer NVIDIA
    GPUs (larger speedup on slower cards where Python overhead dominates).
    Bit-equivalent weights + SDPA math; the AR sampler uses Gumbel-max
    instead of multinomial so different RNG paths produce different rolls
    from the same logit distribution."""

    def __init__(self, gpt_path: str, device: torch.device, dtype: torch.dtype):
        if not torch.cuda.is_available():
            raise RuntimeError(
                "TTS_USE_CUDAGRAPH=1 requires CUDA; falling back is the "
                "caller's responsibility."
            )
        from AR.models.t2s_model_cudagraph import CUDAGraphRunner

        self._runner = CUDAGraphRunner(
            CUDAGraphRunner.load_decoder(gpt_path),
            device=device,
            dtype=dtype,
        )

    def generate(self, all_phone_ids, all_phone_lens, prompt_sem, all_bert,
                 *, top_k, temperature, early_stop_num) -> torch.Tensor:
        from AR.models.structs_cudagraph import T2SRequest

        request = T2SRequest(
            x=[all_phone_ids.squeeze(0)],
            x_lens=all_phone_lens,
            prompts=prompt_sem,
            bert_feature=[all_bert.squeeze(0)],
            valid_length=1,
            top_k=top_k,
            top_p=1.0,
            temperature=temperature,
            early_stop_num=early_stop_num,
            use_cuda_graph=True,
        )
        result = self._runner.generate(request)
        if result.exception is not None:
            # Surface the captured-graph traceback — the wrapped
            # RuntimeError loses the actual stack.
            print(f"[gpt-sovits-engine] CUDA-graph error:\n{result.traceback}")
            raise RuntimeError(
                f"CUDA-graph T2S inference failed: {result.exception}"
            ) from result.exception
        return result.result[0]  # [N] of generated tokens


# ---------------------------------------------------------------------------
# Mel / spec helpers (shared by reference cache + synth)
# ---------------------------------------------------------------------------

_SPEC_MIN, _SPEC_MAX = -12, 2


def _norm_spec(x: torch.Tensor) -> torch.Tensor:
    return (x - _SPEC_MIN) / (_SPEC_MAX - _SPEC_MIN) * 2 - 1


def _denorm_spec(x: torch.Tensor) -> torch.Tensor:
    return (x + 1) / 2 * (_SPEC_MAX - _SPEC_MIN) + _SPEC_MIN


def _load_sovits_ckpt(path: str) -> dict:
    """Load a SoVITS v4 LoRA checkpoint, handling BOTH save formats:

    - Plain torch.save (zip-magic `PK\\x03\\x04`): direct `torch.load`.
      The old hand-trained Asuna ckpts in `SoVITS_weights_v4/` are this
      shape.
    - GPT-SoVITS's `my_save2` format: 2-byte version marker (`b"04"`
      for v4-LoRA) replacing the standard `b"PK"` magic. Used by the
      official training pipeline when `lora_rank` is set. New ckpts
      from `s2_train_v3_lora.py` are this shape.

    The loader peeks the first 2 bytes, restores `PK` if needed, and
    feeds the resulting bytes to `torch.load` via BytesIO. Mirrors
    GPT-SoVITS's `process_ckpt.load_sovits_new`."""
    import io
    with open(path, "rb") as f:
        meta = f.read(2)
        if meta != b"PK":
            data = b"PK" + f.read()
            return torch.load(
                io.BytesIO(data), map_location="cpu", weights_only=False,
            )
    return torch.load(path, map_location="cpu", weights_only=False)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

# Conservative lower-bound speaking rate: ~9.5 CJK char/s, ~19 latin char/s.
# Used by the re-roll heuristic to detect AR early-stop.
_CJK_SECS_PER_CHAR = 0.105
_LATIN_SECS_PER_CHAR = 0.052
# How many re-rolls to attempt when a segment's audio comes back
# suspiciously short. Empirically: 1 retry catches ~90% of early-stops,
# 2 retries catches ~99%. The extra latency (one more AR pass, ~0.5 s)
# is worth eliminating the "last sentence silently dropped" symptom.
_MAX_SYNTH_RETRIES = 2

# Per-segment ACCEPT / SHORT / GIVE UP logs are essential when debugging
# the AR-truncation class of bugs but very chatty in normal operation
# (every reply spams 1-N lines per sentence). Gate them behind
# TTS_VERBOSE_SEGS=1; the GIVE UP / "AR consistently truncating" lines
# stay on regardless because they signal a real problem the user needs
# to see.
_VERBOSE_SEGS = os.environ.get("TTS_VERBOSE_SEGS", "0") == "1"

# Re-roll trigger: `secs < FLOOR_FRAC * expected`. This catches the
# AR early-stop failure mode where the audio is too short to contain
# the input content. Loops + drift are caught by ASR verification
# (below), not by duration heuristics — iter-14 history of duration-
# based loop mitigations the user verified one-by-one:
#
#   iter-14a — truncate audio to expected × 1.15: cut real content
#              ("TTS stopped midway")
#   iter-14b — greedy sampling fallback (top_k=1, temp=0): produced
#              degenerate "nonsense" output
#   iter-14c — ship looped audio whole: "same sentence read twice"
#
# Conclusion: duration is a coarse proxy for content correctness.
# ASR-verified retry is the gold standard — transcribe the synthesized
# audio, compare to the input text, re-roll on mismatch. See
# `_VERIFY_*` settings + `_verify_via_asr` below.
_FLOOR_FRAC = 0.85

# ---------------------------------------------------------------------------
# ASR-verified retry (iter 14 — proper fix for the AR-loop bug class)
#
# When `TTS_VERIFY_ASR_URL` is set (e.g. http://127.0.0.1:9882, the
# speech-sidecar's base URL), the wrapper POSTs each segment's audio
# to `/asr` and computes:
#
#   length_ratio = transcript_chars / input_chars  → catches early-stop
#                                                   (ratio < 0.6) and
#                                                   loop (ratio > 1.4)
#   char_jaccard = |chars(transcript) ∩ chars(input)|  → catches drift
#                  / |chars(transcript) ∪ chars(input)|   (ratio < 0.5
#                                                          on the same
#                                                          script means
#                                                          wrong words)
#
# A take is "verified" iff both checks pass. Otherwise re-roll with
# the next diversity-bumped sampling attempt. Verification costs
# ~200-500 ms per segment with whisper-small on GPU; first sampled
# take is shipped unverified to avoid paying that on the happy path
# (users who don't run the speech sidecar pay zero cost).
# ---------------------------------------------------------------------------
_VERIFY_ASR_URL = os.environ.get("TTS_VERIFY_ASR_URL", "").rstrip("/")
_VERIFY_LEN_LOW = 0.60   # ratio < this  → likely early-stop
_VERIFY_LEN_HIGH = 1.50  # ratio > this  → likely loop
_VERIFY_JACCARD_MIN = 0.45  # below → likely drift / wrong content
_VERIFY_TIMEOUT_S = 15.0


def _normalize_for_compare(s: str) -> str:
    """Strip whitespace + ASCII punctuation; lowercase. Keeps CJK
    chars + JA/CN punctuation intact (which speakers/listeners do
    perceive). The point is to compare CONTENT, not formatting."""
    import unicodedata
    out: list[str] = []
    for ch in s:
        # Drop ASCII punctuation, whitespace, and control chars
        if ch.isspace():
            continue
        cat = unicodedata.category(ch)
        if cat.startswith("P") and ord(ch) < 0x80:
            continue
        out.append(ch.lower())
    return "".join(out)


def _asr_call(audio_pcm_f32: "np.ndarray", sample_rate: int,
              language: str) -> Optional[dict]:
    """Raw ASR call returning the full sidecar response (text +
    per-segment timing). Returns None on any failure — callers must
    treat that as "no ASR data available" and fall back to defaults.

    Used both by `_verify_via_asr` (content correctness check) and
    `_trim_looped_audio` (uses segment timing to find a natural
    speech break for trimming over-long output)."""
    if not _VERIFY_ASR_URL:
        return None
    try:
        import base64
        import io
        import json
        import urllib.request
        import wave

        pcm16 = (np.clip(audio_pcm_f32, -1.0, 1.0) * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm16.tobytes())
        body = json.dumps({
            "audio": base64.b64encode(buf.getvalue()).decode("ascii"),
            "language": language if language in ("ja", "en", "zh") else None,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{_VERIFY_ASR_URL}/asr",
            method="POST",
            headers={"Content-Type": "application/json"},
            data=body,
        )
        with urllib.request.urlopen(req, timeout=_VERIFY_TIMEOUT_S) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _trim_looped_audio(
    audio: "np.ndarray", expected_secs: float, sample_rate: int,
    language: str,
) -> Optional["np.ndarray"]:
    """Salvage a looped take by trimming it down to ~the expected
    duration. AR loops are characteristically `[correct first utterance]
    [loop][loop]...` — the audio leading up to ~expected duration is
    usually the right content.

    Two-tier cut strategy:
    1. Prefer a natural speech break — re-ASR with word-level timestamps
       (so we see word boundaries even when Whisper's VAD groups the
       whole loop into one segment), pick the latest word END in
       `[0.7×, 1.6×]` of expected, cut there.
    2. Fall back to a hard cut at `1.3×` expected when no usable word
       boundary lands in window. Mid-word cuts are masked by a 60ms
       fade-out so they're inaudible as clicks.

    Returns the trimmed audio (always non-None when the audio buffer
    has enough content to trim; None only if the input audio is empty
    or shorter than the would-be cut). The verify call after this
    decides whether the trimmed result is shippable.
    """
    if audio.size == 0:
        return None

    cut_secs: Optional[float] = None
    asr = _asr_call_with_words(audio, sample_rate, language)
    if asr:
        segments = asr.get("segments") or []
        words: list[tuple[float, float]] = []
        for s in segments:
            for w in (s.get("words") or []):
                try:
                    words.append((float(w["start"]), float(w["end"])))
                except (KeyError, ValueError, TypeError):
                    continue
            # Fall back to segment boundary if no per-word data
            if not (s.get("words") or []):
                try:
                    words.append((float(s["start"]), float(s["end"])))
                except (KeyError, ValueError, TypeError):
                    pass
        # Window: prefer cuts in [0.7×, 1.6×] of expected
        lo = expected_secs * 0.7
        hi = expected_secs * 1.6
        for _, end in words:
            if lo <= end <= hi:
                cut_secs = end  # keep updating to get the latest in window
            elif end > hi:
                break

    if cut_secs is None:
        # No natural boundary in window. The hard-cut fallback was
        # tried (cuts at 1.3× expected regardless of word boundaries)
        # but it produced WORSE results on cloned-voice TTS: the
        # truncated audio lost too much context for Whisper to recover
        # any content, and the AR's first iteration is often itself
        # partially garbled (not "correct then loop", but "garbled
        # that loops"). Better to ship the looped original than a
        # truncated mess. Real fix lives at the model level.
        return None

    cut_samples = min(audio.size, max(1, int(cut_secs * sample_rate)))
    if cut_samples <= int(0.1 * sample_rate):
        # Too short to be useful audio — refuse.
        return None
    trimmed = audio[:cut_samples].copy()
    # 60 ms fade-out — long enough to mask a mid-word cut, short
    # enough that the user perceives "natural ending" rather than
    # "obvious fade".
    fade_samples = min(int(0.060 * sample_rate), trimmed.size)
    if fade_samples > 0:
        fade = np.linspace(1.0, 0.0, fade_samples, dtype=np.float32)
        trimmed[-fade_samples:] *= fade
    return trimmed


def _asr_call_with_words(audio_pcm_f32: "np.ndarray", sample_rate: int,
                         language: str) -> Optional[dict]:
    """ASR call requesting word-level timestamps. Same wire as
    `_asr_call` but with `word_timestamps=true` so the loop-trim
    helper can cut at word boundaries even when Whisper's segment-
    level VAD-filter bundles a whole loop into one segment.

    Whisper paid the extra ~30% wall on word timestamps; we only call
    this on the trim path (already a failure-recovery code path, latency
    budget is forgiving). Returns the parsed response dict, or None on
    any failure."""
    if not _VERIFY_ASR_URL:
        return None
    try:
        import base64
        import io
        import json
        import urllib.request
        import wave

        pcm16 = (np.clip(audio_pcm_f32, -1.0, 1.0) * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm16.tobytes())
        body = json.dumps({
            "audio": base64.b64encode(buf.getvalue()).decode("ascii"),
            "language": language if language in ("ja", "en", "zh") else None,
            "word_timestamps": True,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{_VERIFY_ASR_URL}/asr",
            method="POST",
            headers={"Content-Type": "application/json"},
            data=body,
        )
        with urllib.request.urlopen(req, timeout=_VERIFY_TIMEOUT_S) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _verify_via_asr(audio_pcm_f32: "np.ndarray", input_text: str,
                    sample_rate: int, language: str) -> tuple[bool, str]:
    """POST the synthesized audio to the speech sidecar and assert the
    transcript matches the input. Returns (ok, reason) where reason
    names the failed check or 'ok'. Falls back to (True, 'skipped')
    if the sidecar URL is unset or the request fails — verification
    is best-effort, never blocks the user when the sidecar is down."""
    if not _VERIFY_ASR_URL:
        return True, "skipped (no TTS_VERIFY_ASR_URL)"
    try:
        import base64
        import io
        import json
        import urllib.request
        import wave

        # Convert float32 PCM → 16-bit WAV (Whisper accepts wav direct).
        pcm16 = (np.clip(audio_pcm_f32, -1.0, 1.0) * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm16.tobytes())
        audio_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        body = json.dumps({
            "audio": audio_b64,
            "language": language if language in ("ja", "en", "zh") else None,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{_VERIFY_ASR_URL}/asr",
            method="POST",
            headers={"Content-Type": "application/json"},
            data=body,
        )
        with urllib.request.urlopen(req, timeout=_VERIFY_TIMEOUT_S) as r:
            result = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        # Sidecar down / network glitch / model load fail — don't block
        # the user. Surface as skipped, log once per failure mode.
        return True, f"skipped (sidecar error: {type(e).__name__}: {str(e)[:80]})"

    transcript = result.get("text", "")
    nt = _normalize_for_compare(transcript)
    ni = _normalize_for_compare(input_text)
    if not ni:
        return True, "skipped (input empty after normalize)"
    # Whisper is unreliable on sub-1s clips — it often returns empty
    # for short inputs even when audio is perfectly fine. Skip
    # verification for very-short inputs so the warmup ("テスト" / 3
    # chars / ~0.4s) and "yes"/"no"/"はい" type one-word replies don't
    # trigger spurious re-rolls.
    if len(ni) < 5:
        return True, f"skipped (input too short: {len(ni)}c — Whisper unreliable below ~1s)"

    # 1. Length ratio — catches early-stop AND loop
    ratio = len(nt) / max(1, len(ni))
    if ratio < _VERIFY_LEN_LOW:
        return False, (
            f"early-stop: transcript {len(nt)}c / input {len(ni)}c "
            f"= {ratio:.0%} (<{_VERIFY_LEN_LOW:.0%}) — heard {nt[:40]!r}"
        )
    if ratio > _VERIFY_LEN_HIGH:
        return False, (
            f"loop: transcript {len(nt)}c / input {len(ni)}c "
            f"= {ratio:.0%} (>{_VERIFY_LEN_HIGH:.0%}) — heard {nt[:40]!r}"
        )

    # 2. Character-set Jaccard — catches drift / wrong content
    set_t = set(nt)
    set_i = set(ni)
    if set_i:
        jac = len(set_t & set_i) / len(set_t | set_i)
        if jac < _VERIFY_JACCARD_MIN:
            return False, (
                f"drift: char-set Jaccard {jac:.2f} (<{_VERIFY_JACCARD_MIN:.2f}) "
                f"— input {ni[:30]!r} vs transcript {nt[:30]!r}"
            )

    return True, f"ok (len={ratio:.0%}, jac={jac:.2f})"


class GPTSoVITSEngine:
    """GPT-SoVITS v4 zero-shot synthesis. One instance owns all model
    state; thread-safe for synthesize() under serial /tts calls (the AR
    backend is not designed for concurrent invocation).

    The output sample rate is fixed at `OUTPUT_SAMPLE_RATE` (48 kHz)."""

    OUTPUT_SAMPLE_RATE = OUTPUT_SAMPLE_RATE

    def __init__(self, config: EngineConfig):
        self.config = config
        self.device = self._select_device(config.gpu_device)
        self._gpt_path: Optional[str] = None
        self._sovits_path: Optional[str] = None
        # Lazy state — initialized in _load.
        self._hubert = None
        self._vits = None
        self._vocoder = None
        self._hps = None
        self._ar: Optional[ARBackend] = None
        # BERT is loaded lazily on first zh call; English text uses zeros.
        self._bert_pair: Optional[tuple] = None
        self._nltk_ready = False
        # Reference cache (populated by _cache_reference)
        self._ref_semantic: Optional[torch.Tensor] = None
        self._ref_phone_ids: Optional[list[int]] = None
        self._ref_spec: Optional[torch.Tensor] = None
        self._ref_mel: Optional[torch.Tensor] = None
        # Shutdown idempotency
        self._cleanup_done = False

        self._setup_paths()
        self._load_all()
        self._cache_reference()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def ar_backend_name(self) -> str:
        return "cuda-graph" if isinstance(self._ar, CudaGraphARBackend) else "naive"

    def synthesize(
        self,
        text: str,
        language: Optional[str] = None,
        *,
        sample_steps: Optional[int] = None,
        top_k: int = 15,
        temperature: float = 1.0,
    ) -> np.ndarray:
        """Synthesize `text` in `language` ("ja" | "en" | "zh"). Returns a
        48 kHz mono float32 waveform; empty array if input has no speakable
        characters."""
        lang = language or self.config.default_language
        steps = sample_steps if sample_steps is not None else self.config.cfm_sample_steps
        segments = split_for_tts(text, lang)
        if not segments:
            return np.zeros(0, dtype=np.float32)

        gap = np.zeros(int(self.OUTPUT_SAMPLE_RATE * SEG_GAP_SECONDS), dtype=np.float32)
        pieces: list[np.ndarray] = []
        for i, seg in enumerate(segments):
            a = self._synthesize_robust(seg, lang, i, len(segments), top_k, temperature, steps)
            if a.size == 0:
                continue
            if pieces:
                pieces.append(gap)
            pieces.append(a)
        if not pieces:
            return np.zeros(0, dtype=np.float32)
        if len(pieces) == 1:
            return pieces[0]
        return np.concatenate(pieces).astype(np.float32)

    def warmup(self) -> float:
        """Run a tiny synth to pre-pay the first-call cuDNN heuristic +
        kernel JIT cost. Returns wall-clock seconds elapsed."""
        warmup_text = {
            "ja": "テスト",
            "en": "Test",
            "zh": "测试",  # also lazily loads BERT
        }.get(self.config.default_language, "test")
        t0 = time.time()
        try:
            self.synthesize(warmup_text, self.config.default_language)
        except Exception as e:
            print(f"[gpt-sovits-engine] warmup failed (continuing): {e!r}")
            return time.time() - t0
        elapsed = time.time() - t0
        print(
            f"[gpt-sovits-engine] warmup done in {elapsed:.2f}s "
            f"(lang={self.config.default_language!r}, text={warmup_text!r})"
        )
        return elapsed

    def shutdown(self) -> None:
        """Release VRAM and trigger CUDA cleanup. Idempotent."""
        if self._cleanup_done:
            return
        self._cleanup_done = True
        try:
            # Drop model references so PyTorch can release VRAM.
            self._hubert = None
            self._vits = None
            self._vocoder = None
            self._ar = None
            self._bert_pair = None
            self._ref_semantic = None
            self._ref_spec = None
            self._ref_mel = None
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
                try:
                    torch.cuda.reset_peak_memory_stats()
                except Exception:
                    pass
            print("[gpt-sovits-engine] CUDA cleanup done")
        except Exception as e:
            print(f"[gpt-sovits-engine] cleanup error (continuing): {e}")

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------

    @staticmethod
    def _select_device(gpu_device: int) -> torch.device:
        if gpu_device < 0 or not torch.cuda.is_available():
            return torch.device("cpu")
        return torch.device(f"cuda:{gpu_device}" if gpu_device > 0 else "cuda:0")

    def _setup_paths(self) -> None:
        root = self.config.model_path
        if not root.exists():
            raise SystemExit(f"GPT-SoVITS root not found: {root}")
        # GPT-SoVITS internal code uses relative paths for resources.
        os.chdir(str(root))
        sys.path.insert(0, str(root))
        sys.path.insert(0, str(root / "GPT_SoVITS"))
        os.environ["version"] = "v4"
        if self.config.ffmpeg_bin:
            os.environ["PATH"] = (
                str(self.config.ffmpeg_bin) + os.pathsep + os.environ.get("PATH", "")
            )

    def _load_all(self) -> None:
        root = self.config.model_path
        cnhubert_path = str(root / "GPT_SoVITS" / "pretrained_models" / "chinese-hubert-base")
        s2_config = str(root / "GPT_SoVITS" / "configs" / "s2.json")
        pretrained_s2g_v4 = str(
            root / "GPT_SoVITS" / "pretrained_models" / "gsv-v4-pretrained" / "s2Gv4.pth"
        )
        vocoder_path = str(
            root / "GPT_SoVITS" / "pretrained_models" / "gsv-v4-pretrained" / "vocoder.pth"
        )

        self._load_hubert(cnhubert_path)
        self._load_sovits(s2_config, pretrained_s2g_v4)
        self._load_vocoder(vocoder_path)
        self._ar = self._make_ar_backend()
        # When cuda-graph is the primary AR, eagerly load the naive AR
        # too as a rescue path. Some inputs (multi-sentence, digits,
        # certain CJK punctuation runs) consistently early-stop or loop
        # under cuda-graph capture — the verify+retry loop catches the
        # issue but can't always escape (the graph captures the same
        # forward pass each replay). The naive backend doesn't have
        # that bias, so we fall back to it per-segment when verify
        # exhausts retries. Cost: +~150 MB VRAM for the second GPT.
        # Without this, `use_cuda_graph = true` ships broken audio for
        # the affected inputs — unacceptable for a professional app.
        self._ar_fallback: Optional[ARBackend] = None
        if isinstance(self._ar, CudaGraphARBackend) and self._gpt_path:
            print(
                "[gpt-sovits-engine] Loading naive AR (rescue path for "
                "cuda-graph verify-fails)..."
            )
            try:
                self._ar_fallback = NaiveARBackend(
                    self._gpt_path, _S1_CONFIG, self.device,
                )
                print(
                    "[gpt-sovits-engine]   naive rescue path ready "
                    "(fires only when cuda-graph segment fails verify)"
                )
            except Exception as e:
                # If the rescue path fails to load, the primary still
                # works — log and continue. Better than crashing the
                # whole engine.
                print(
                    f"[gpt-sovits-engine] WARN: failed to load naive "
                    f"rescue path: {e}. cuda-graph verify-fails will "
                    f"ship best-attempt instead of falling back."
                )

    def _load_hubert(self, cnhubert_path: str) -> None:
        print("[gpt-sovits-engine] Loading HuBERT...")
        from GPT_SoVITS.feature_extractor import cnhubert
        cnhubert.cnhubert_base_path = cnhubert_path
        self._hubert = cnhubert.get_model().half().to(self.device).eval()

    def _load_sovits(self, s2_config: str, pretrained_s2g_v4: str) -> None:
        print("[gpt-sovits-engine] Loading SoVITS v4 (DiT + LoRA-merged)...")
        import GPT_SoVITS.utils as utils
        from GPT_SoVITS.module.models import SynthesizerTrnV3
        from peft import LoraConfig, get_peft_model

        hps = utils.get_hparams_from_file(s2_config)
        hps.model.version = "v4"
        self._hps = hps

        vits = SynthesizerTrnV3(
            hps.data.filter_length // 2 + 1,
            hps.train.segment_size // hps.data.hop_length,
            n_speakers=hps.data.n_speakers,
            **hps.model,
        )
        base_state = torch.load(pretrained_s2g_v4, map_location="cpu", weights_only=False)["weight"]
        vits.load_state_dict(base_state, strict=False)

        # Find the user's fine-tuned ckpt FIRST so we can read its
        # `lora_rank` field and construct the LoraConfig with the
        # matching rank. Without this, loading a ckpt with rank≠32
        # fails with shape-mismatch errors. The lora_rank lives in
        # the ckpt opt dict (written by process_ckpt.savee when
        # lora_rank is set).
        sovits_path = self._find_sovits_ckpt()
        self._sovits_path = sovits_path
        print(f"[gpt-sovits-engine]   SoVITS ckpt: {Path(sovits_path).name}")
        ft_ckpt = _load_sovits_ckpt(sovits_path)
        ft_state = ft_ckpt["weight"]
        # Detect rank: prefer the ckpt's stored field, else infer from
        # weight shape (lora_A is (rank, 1024); rank = first dim).
        rank = ft_ckpt.get("lora_rank")
        if not rank:
            for k, v in ft_state.items():
                if "lora_A" in k and v.ndim == 2:
                    rank = int(v.shape[0])
                    break
        rank = int(rank) if rank else 32
        print(f"[gpt-sovits-engine]   LoRA rank from ckpt: {rank}")

        lora_config = LoraConfig(
            target_modules=["to_k", "to_q", "to_v", "to_out.0"],
            r=rank,
            lora_alpha=rank,
            init_lora_weights=True,
        )
        vits.cfm = get_peft_model(vits.cfm, lora_config)

        vits.load_state_dict(ft_state, strict=False)
        vits.cfm = vits.cfm.merge_and_unload()
        self._vits = vits.half().to(self.device).eval()

    def _find_sovits_ckpt(self) -> str:
        sovits_dir = self.config.model_path / "SoVITS_weights_v4"
        prefix = self.config.lora_prefix
        patterns = ([f"{prefix}*.pth"] if prefix else []) + ["*.pth"]
        for pat in patterns:
            hits = list(sovits_dir.glob(pat))
            if hits:
                try:
                    hits = sorted(hits, key=lambda p: int(p.stem.split("_e")[1].split("_")[0]))
                except (IndexError, ValueError):
                    pass
                return str(hits[-1])
        raise SystemExit(
            f"No SoVITS LoRA checkpoints found in {sovits_dir}. Set TTS_LORA_NAME "
            f"or place a fine-tune in SoVITS_weights_v4/."
        )

    def _load_vocoder(self, vocoder_path: str) -> None:
        print("[gpt-sovits-engine] Loading 48kHz vocoder...")
        from GPT_SoVITS.module.models import Generator

        vocoder = Generator(
            initial_channel=100,
            resblock="1",
            resblock_kernel_sizes=[3, 7, 11],
            resblock_dilation_sizes=[[1, 3, 5], [1, 3, 5], [1, 3, 5]],
            upsample_rates=[10, 6, 2, 2, 2],
            upsample_initial_channel=512,
            upsample_kernel_sizes=[20, 12, 4, 4, 4],
            gin_channels=0,
            is_bias=True,
        )
        # remove_weight_norm must run BEFORE loading; ckpt has plain weights.
        vocoder.remove_weight_norm()
        vocoder.load_state_dict(torch.load(vocoder_path, map_location="cpu", weights_only=False))
        self._vocoder = vocoder.half().to(self.device).eval()

    def _make_ar_backend(self) -> ARBackend:
        gpt_path = self._find_gpt_ckpt()
        self._gpt_path = gpt_path
        print(f"[gpt-sovits-engine]   GPT ckpt: {Path(gpt_path).name}")
        if self.config.use_cuda_graph:
            if not torch.cuda.is_available():
                print(
                    "[gpt-sovits-engine] TTS_USE_CUDAGRAPH=1 but CUDA unavailable; "
                    "falling back to naive AR"
                )
            else:
                print("[gpt-sovits-engine] Loading GPT (CUDA-graph runner)...")
                ar = CudaGraphARBackend(gpt_path, self.device, torch.float16)
                print(
                    "[gpt-sovits-engine]   CUDA-graph runner ready "
                    "(graph captures on first synth)"
                )
                return ar
        print("[gpt-sovits-engine] Loading GPT (naive AR)...")
        return NaiveARBackend(gpt_path, _S1_CONFIG, self.device)

    def _find_gpt_ckpt(self) -> str:
        gpt_dir = self.config.model_path / "GPT_weights_v3"
        prefix = self.config.lora_prefix
        # Training names files as `<prefix>-e<epoch>.ckpt`. Try strict, then
        # tolerate suffixed prefixes (e.g. user gave "asuna", file is
        # "asuna_combined-e15.ckpt"), then "any LoRA in dir".
        patterns = []
        if prefix:
            patterns.append(f"{prefix}-e*.ckpt")
            patterns.append(f"{prefix}*-e*.ckpt")
        patterns.append("*-e*.ckpt")
        for pat in patterns:
            hits = list(gpt_dir.glob(pat))
            if hits:
                try:
                    hits = sorted(hits, key=lambda p: int(p.stem.split("-e")[1]))
                except (IndexError, ValueError):
                    hits = sorted(hits)
                return str(hits[-1])
        raise SystemExit(
            f"No GPT checkpoints found in {gpt_dir}. Set TTS_LORA_NAME or "
            f"place a fine-tune in GPT_weights_v3/."
        )

    def _cache_reference(self) -> None:
        ref_path = str(self.config.reference_audio)
        print(
            f"[gpt-sovits-engine] Caching reference: {Path(ref_path).name} "
            f"({self.config.reference_language})"
        )
        ref_ssl = self._ssl(ref_path)
        with torch.no_grad():
            ref_codes = self._vits.extract_latent(ref_ssl)
        self._ref_semantic = ref_codes[0, 0, :]
        self._ref_phone_ids, _, _ = self._phoneme_ids(
            self.config.reference_text, self.config.reference_language,
        )
        self._ref_spec = self._spec_from_wav(ref_path).half().to(self.device)
        self._ref_mel = self._mel_from_wav(ref_path)

    # ------------------------------------------------------------------
    # Synthesis helpers
    # ------------------------------------------------------------------

    def _ensure_nltk(self) -> None:
        if self._nltk_ready:
            return
        import nltk
        for pkg in ("averaged_perceptron_tagger_eng", "cmudict", "averaged_perceptron_tagger"):
            try:
                nltk.data.find(f"taggers/{pkg}" if "tagger" in pkg else f"corpora/{pkg}")
            except LookupError:
                nltk.download(pkg, quiet=True)
        self._nltk_ready = True

    def _get_bert(self):
        if self._bert_pair is None:
            print("[gpt-sovits-engine] Loading BERT (first zh request)...")
            from transformers import AutoModelForMaskedLM, AutoTokenizer
            bert_path = str(
                self.config.model_path / "GPT_SoVITS" / "pretrained_models"
                / "chinese-roberta-wwm-ext-large"
            )
            tok = AutoTokenizer.from_pretrained(bert_path, local_files_only=True)
            mdl = (
                AutoModelForMaskedLM.from_pretrained(bert_path, local_files_only=True)
                .half().to(self.device).eval()
            )
            self._bert_pair = (tok, mdl)
        return self._bert_pair

    def _phoneme_ids(self, text: str, lang: str):
        if lang == "en":
            self._ensure_nltk()
        # Pre-normalise the text so pyopenjtalk never sees patterns the
        # AR wasn't trained on. The biggest win here is English
        # loanwords: without this, pyopenjtalk spells out "sunny" as
        # 14 individual phonemes (`e s u y u u e n u e n u w a i`),
        # which the AR's LoRA has never seen — it loops. After this
        # normaliser, "sunny" → "サニー" → ~3 phonemes (in-distribution).
        # See `text_normalize.py` for the full normalisation list.
        try:
            from text_normalize import normalize_for_tts
            text = normalize_for_tts(text, lang=lang)
        except Exception as e:
            # Defensive: if the normaliser ever crashes, fall back to
            # raw text — better degraded output than no audio at all.
            print(f"[gpt-sovits-engine] text_normalize failed: {e!r}; using raw")
        from GPT_SoVITS.text import cleaned_text_to_sequence
        from GPT_SoVITS.text.cleaner import clean_text
        phones, w2p, norm = clean_text(text, lang, "v2")
        return cleaned_text_to_sequence(phones, "v2"), w2p, norm

    def _bert_for(self, phone_ids, w2p, norm, lang) -> torch.Tensor:
        if lang != "zh":
            return torch.zeros((1024, len(phone_ids)), dtype=torch.float32)
        tokenizer, bert = self._get_bert()
        # `no_grad` (not `inference_mode`): the returned tensor crosses
        # back to the caller and gets reused inside an `inference_mode`
        # block. Mixing the two contexts errors.
        with torch.no_grad():
            inp = {k: v.to(self.device) for k, v in tokenizer(norm, return_tensors="pt").items()}
            out = bert(**inp, output_hidden_states=True)
            res = torch.cat(out["hidden_states"][-3:-2], -1)[0].cpu()[1:-1]
        feats = [res[i].repeat(w2p[i], 1) for i in range(len(w2p))]
        return torch.cat(feats, dim=0).T

    def _ssl(self, wav_path: str) -> torch.Tensor:
        import librosa
        from tools.my_utils import load_audio
        audio = load_audio(wav_path, 32000)
        audio16 = librosa.resample(audio, orig_sr=32000, target_sr=16000).astype(np.float32)
        t = torch.from_numpy(audio16).half().to(self.device)
        with torch.no_grad():
            return self._hubert.model(t.unsqueeze(0))["last_hidden_state"].transpose(1, 2)

    def _spec_from_wav(self, wav_path: str) -> torch.Tensor:
        from GPT_SoVITS.module.mel_processing import spectrogram_torch
        from tools.my_utils import load_audio
        audio = load_audio(wav_path, self._hps.data.sampling_rate)
        return spectrogram_torch(
            torch.FloatTensor(audio).unsqueeze(0),
            self._hps.data.filter_length,
            self._hps.data.sampling_rate,
            self._hps.data.hop_length,
            self._hps.data.win_length,
            center=False,
        )

    def _mel_from_wav(self, wav_path: str) -> torch.Tensor:
        from GPT_SoVITS.module.mel_processing import mel_spectrogram_torch
        from tools.my_utils import load_audio
        audio = load_audio(wav_path, 32000)
        audio_t = torch.FloatTensor(audio).unsqueeze(0).to(self.device)
        mel = mel_spectrogram_torch(
            audio_t,
            n_fft=1280, win_size=1280, hop_size=320,
            num_mels=100, sampling_rate=32000,
            fmin=0, fmax=None, center=False,
        )
        return _norm_spec(mel).half()

    def _expected_min_secs(self, seg: str) -> float:
        return len(seg) * (_CJK_SECS_PER_CHAR if _has_cjk(seg) else _LATIN_SECS_PER_CHAR)

    def _synthesize_robust(self, seg: str, lang: str, idx: int, total: int,
                           top_k: int, temperature: float, sample_steps: int) -> np.ndarray:
        """Synthesize one segment with early-stop detection + re-roll.

        **Scope (reset iter 14):** this function fixes the AR
        *early-stop* failure mode (audio truncated short) by re-rolling
        with mild sampling diversity. It does NOT attempt to fix AR
        loops; those are an upstream GPT-SoVITS v4 issue
        (cuda-graph backend has stable loop bias on some inputs).
        Iter-14 tried truncate-on-long and greedy-fallback — both
        introduced worse failure modes (clipped content, degenerate
        nonsense). The honest mitigation for loops is at the AR-backend
        level: Settings → CUDA Graphs OFF uses the naive backend which
        doesn't loop on the affected inputs (~20% slower).
        """
        best = np.zeros(0, dtype=np.float32)
        expected = self._expected_min_secs(seg)
        # Short-segment floor: keep the 0.7s minimum but cap at 1.1× expected
        # so a 2-char segment with ~0.2s expected doesn't re-roll forever.
        floor = min(_FLOOR_FRAC * expected, expected * 1.1)
        floor = max(0.25, floor)
        if _VERBOSE_SEGS:
            print(
                f"[gpt-sovits-engine] seg {idx + 1}/{total} ({len(seg)}ch): "
                f"expected≈{expected:.2f}s floor={floor:.2f}s text={seg[:60]!r}"
            )

        attempt_lens: list[float] = []
        # Per-attempt history: list of (audio, secs, verdict_str) so we
        # can pick the BEST one if all attempts fail verification.
        attempts: list[tuple["np.ndarray", float, str]] = []
        for attempt in range(_MAX_SYNTH_RETRIES + 1):
            attempt_top_k = top_k + 15 * attempt
            attempt_temp = temperature + 0.15 * attempt
            try:
                a = self._synthesize_segment(
                    seg, lang, attempt_top_k, attempt_temp, sample_steps,
                )
            except Exception as e:
                print(
                    f"[gpt-sovits-engine] seg {idx + 1}/{total} attempt "
                    f"{attempt + 1} crashed: {e!r}"
                )
                continue
            secs = a.size / self.OUTPUT_SAMPLE_RATE
            attempt_lens.append(secs)
            # "best = longest" works for early-stop failures (you want
            # more content). For loop failures (>150% of expected) it's
            # the WORST choice — but the alternative ("closest to
            # expected") regresses worse: picks rescue's near-silent
            # output over cuda-graph's loop, and silence is worse UX
            # than repetition (the user perceives "voice is broken" vs
            # "voice stuttered"). Stick with longest; loops are bounded
            # by the engine's hard-cap segment length anyway.
            if a.size > best.size:
                best = a
            ratio = secs / expected if expected > 0 else 1.0

            # Duration check first — fastest, no extra cost
            if secs < floor:
                attempts.append((a, secs, f"SHORT({secs:.2f}s<{floor:.2f}s)"))
                if attempt < _MAX_SYNTH_RETRIES and _VERBOSE_SEGS:
                    print(
                        f"[gpt-sovits-engine] seg {idx + 1}/{total} attempt "
                        f"{attempt + 1} SHORT: {secs:.2f}s vs ≥{floor:.2f}s — "
                        f"re-rolling"
                    )
                continue

            # Duration looks fine — now ASR-verify content. This catches
            # AR loops + drift that the duration check can't. On the FIRST
            # attempt we accept based on duration alone (happy-path speed):
            # only if a later attempt fails do we go back and ASR-verify
            # earlier takes too. Net cost on the common case: zero.
            if _VERIFY_ASR_URL:
                ok, reason = _verify_via_asr(
                    a, seg, self.OUTPUT_SAMPLE_RATE, lang,
                )
                if not ok:
                    attempts.append((a, secs, f"VERIFY_FAIL({reason})"))
                    if attempt < _MAX_SYNTH_RETRIES:
                        print(
                            f"[gpt-sovits-engine] seg {idx + 1}/{total} attempt "
                            f"{attempt + 1} VERIFY FAILED ({reason}) — re-rolling"
                        )
                        continue
                    else:
                        # Out of retries under the primary AR. Don't
                        # accept yet — if we're in cuda-graph mode and
                        # have a naive rescue path, the after-loop block
                        # will try that next. Just note the exhaustion
                        # and break out so the rescue path can run.
                        print(
                            f"[gpt-sovits-engine] seg {idx + 1}/{total} verify "
                            f"exhausted under primary AR: {reason}"
                        )
                        break
                if _VERBOSE_SEGS:
                    print(
                        f"[gpt-sovits-engine] seg {idx + 1}/{total} attempt "
                        f"{attempt + 1} VERIFY: {reason}"
                    )

            if _VERBOSE_SEGS:
                print(
                    f"[gpt-sovits-engine] seg {idx + 1}/{total} attempt "
                    f"{attempt + 1} ACCEPT: {secs:.2f}s ({ratio:.0%} of "
                    f"expected, top_k={attempt_top_k}, "
                    f"temp={attempt_temp:.2f})"
                )
            return a  # accepted: duration ok + (verify ok OR verify unavailable)

        best_secs = best.size / self.OUTPUT_SAMPLE_RATE
        # Cuda-graph rescue path: if we exhausted retries under cuda-graph
        # AR, try ONE attempt with the naive backend. The capture-and-
        # replay nature of cuda-graph makes some inputs deterministically
        # loop or early-stop; naive Python AR has different sampling
        # dynamics and typically clears the same input. Only fires when:
        #   - cuda-graph is the primary backend
        #   - verify is enabled (otherwise we have no signal to rescue from)
        #   - the eager naive load succeeded at engine init
        # We pay one extra ~0.5-1s of latency for the rescue, but the
        # alternative (shipping broken audio) is the bug this fix exists
        # to eliminate.
        if self._ar_fallback is not None and _VERIFY_ASR_URL:
            print(
                f"[gpt-sovits-engine] seg {idx + 1}/{total} cuda-graph "
                f"exhausted; trying naive AR rescue path..."
            )
            primary_ar = self._ar
            self._ar = self._ar_fallback
            try:
                a = self._synthesize_segment(
                    seg, lang,
                    top_k + 15 * (_MAX_SYNTH_RETRIES + 1),
                    temperature + 0.15 * (_MAX_SYNTH_RETRIES + 1),
                    sample_steps,
                )
                rescue_secs = a.size / self.OUTPUT_SAMPLE_RATE
                ok, reason = _verify_via_asr(
                    a, seg, self.OUTPUT_SAMPLE_RATE, lang,
                )
                if ok:
                    print(
                        f"[gpt-sovits-engine] seg {idx + 1}/{total} naive "
                        f"rescue ACCEPT: {rescue_secs:.2f}s ({reason})"
                    )
                    return a
                # Both backends failed verify. Pick whichever ISN'T
                # near-silent: a rescue-path output with RMS ≈ 0 is
                # what AR collapse produces (the LoRA emits silence
                # instead of looping), and shipping silence is worse
                # UX than cuda-graph's stuttering. RMS threshold of
                # 0.01 in normalized float PCM ≈ -40 dBFS, well below
                # normal TTS levels (~-15 to -20 dBFS) but well above
                # numerical noise floor.
                rescue_rms = float(
                    np.sqrt(np.mean(a.astype(np.float64) ** 2))
                ) if a.size > 0 else 0.0
                rescue_is_silent = rescue_rms < 0.01
                if not rescue_is_silent and a.size > best.size:
                    print(
                        f"[gpt-sovits-engine] seg {idx + 1}/{total} naive "
                        f"rescue also failed verify ({reason}); using "
                        f"naive output (audible + longer: "
                        f"{rescue_secs:.2f}s rms={rescue_rms:.3f} vs "
                        f"cuda-graph's {best_secs:.2f}s)"
                    )
                    return a
                silence_note = " (rescue near-silent)" if rescue_is_silent else ""
                print(
                    f"[gpt-sovits-engine] seg {idx + 1}/{total} naive "
                    f"rescue ALSO failed ({reason}){silence_note}; "
                    f"shipping cuda-graph best={best_secs:.2f}s"
                )
            except Exception as e:
                print(
                    f"[gpt-sovits-engine] seg {idx + 1}/{total} naive "
                    f"rescue crashed: {e!r}; shipping cuda-graph best"
                )
            finally:
                self._ar = primary_ar

        # Loop-trim salvage: if we're about to ship over-length audio
        # (>1.5× expected — the `_VERIFY_LEN_HIGH` threshold for "this
        # is a loop"), try trimming at the first natural speech break
        # near the expected duration. AR loops typically have the form
        # `[correct first utterance][loop][loop]...` — the audio up to
        # ~expected duration is usually the right content. We re-ASR
        # to get segment timing, cut at a real speech pause, then fade
        # out 30 ms so the cut isn't audible as a click.
        #
        # Only runs when:
        #   - verify is enabled (we need ASR signal)
        #   - best is over-length (loop pattern, not early-stop / drift)
        # On early-stop or drift, trimming would either chop content or
        # do nothing useful. The trim helper itself refuses to cut if
        # there's no segment-end in the trim window.
        if (
            _VERIFY_ASR_URL
            and expected > 0
            and best_secs > expected * _VERIFY_LEN_HIGH
        ):
            trimmed = _trim_looped_audio(
                best, expected, self.OUTPUT_SAMPLE_RATE, lang,
            )
            if trimmed is not None and trimmed.size > 0:
                trim_secs = trimmed.size / self.OUTPUT_SAMPLE_RATE
                ok, reason = _verify_via_asr(
                    trimmed, seg, self.OUTPUT_SAMPLE_RATE, lang,
                )
                if ok:
                    print(
                        f"[gpt-sovits-engine] seg {idx + 1}/{total} LOOP "
                        f"TRIMMED: cut {best_secs:.2f}s → {trim_secs:.2f}s "
                        f"clean ({reason})"
                    )
                    return trimmed
                # Trimmed audio still verify-fails (e.g., partial loop
                # remains, or trimmed too short → early-stop verdict).
                # Still ship the trimmed version — bounded loop / mild
                # early-stop is better UX than unbounded looping.
                print(
                    f"[gpt-sovits-engine] seg {idx + 1}/{total} LOOP "
                    f"TRIMMED: cut {best_secs:.2f}s → {trim_secs:.2f}s "
                    f"(still {reason}); shipping trimmed anyway — "
                    f"bounded > unbounded loop"
                )
                return trimmed
            print(
                f"[gpt-sovits-engine] seg {idx + 1}/{total} would trim "
                f"loop but no usable cut point found ({best_secs:.2f}s, "
                f"expected≈{expected:.2f}s)"
            )

        # All-attempts-similar → AR is biased on this input, not unlucky
        if attempt_lens and max(attempt_lens) - min(attempt_lens) < 0.15 * max(attempt_lens):
            print(
                f"[gpt-sovits-engine] seg {idx + 1}/{total} GIVE UP — "
                f"AR consistently truncating (attempts: "
                f"{', '.join(f'{s:.2f}s' for s in attempt_lens)}); "
                f"best={best_secs:.2f}s. Rephrase the input or check "
                f"the LoRA fine-tune — both AR backends agree this "
                f"segment is unrenderable."
            )
        else:
            print(
                f"[gpt-sovits-engine] seg {idx + 1}/{total} GIVE UP after "
                f"{_MAX_SYNTH_RETRIES + 1} tries; best={best_secs:.2f}s "
                f"(attempts: {', '.join(f'{s:.2f}s' for s in attempt_lens)})"
            )
        return best

    def _synthesize_segment(self, text: str, lang: str, top_k: int,
                            temperature: float, sample_steps: int) -> np.ndarray:
        phone_ids, w2p, norm = self._phoneme_ids(text, lang)
        bert_feat = self._bert_for(phone_ids, w2p, norm, lang)
        all_phone_ids = torch.LongTensor(phone_ids).unsqueeze(0).to(self.device)
        all_phone_lens = torch.LongTensor([len(phone_ids)]).to(self.device)
        all_bert = bert_feat.half().unsqueeze(0).to(self.device)
        prompt_sem = self._ref_semantic[: min(50, self._ref_semantic.shape[0])].unsqueeze(0).to(self.device)

        # Cap AR generation at ~54s of audio (sampling_rate // hop_length tokens/sec).
        # We segment for ~2-3 sentences anyway; this is the safety belt.
        early_stop = self._hps.data.sampling_rate // self._hps.data.hop_length * 54

        # Single inference_mode covers AR + CFM + vocoder so inference
        # tensors stay within one context. ~5-10% faster than no_grad.
        with torch.inference_mode():
            pred_tokens = self._ar.generate(
                all_phone_ids, all_phone_lens, prompt_sem, all_bert,
                top_k=top_k, temperature=temperature, early_stop_num=early_stop,
            )
            pred_sem = pred_tokens.unsqueeze(0).unsqueeze(0).to(self.device)

            prompt_sem_full = self._ref_semantic.unsqueeze(0).unsqueeze(0).to(self.device)
            ref_phones_t = torch.LongTensor(self._ref_phone_ids).unsqueeze(0).to(self.device)
            fea_ref, ge = self._vits.decode_encp(prompt_sem_full, ref_phones_t, self._ref_spec)
            fea_todo, ge = self._vits.decode_encp(pred_sem, all_phone_ids, self._ref_spec, ge, 1.0)

            T_min = min(self._ref_mel.shape[2], fea_ref.shape[2])
            mel2 = self._ref_mel[:, :, :T_min]
            fea_ref = fea_ref[:, :, :T_min]
            T_ref = 500     # vocoder_configs["T_ref"] for v4
            T_chunk = 1000  # vocoder_configs["T_chunk"] for v4
            if T_min > T_ref:
                mel2 = mel2[:, :, -T_ref:]
                fea_ref = fea_ref[:, :, -T_ref:]
                T_min = T_ref
            chunk_len = T_chunk - T_min

            cfm_results = []
            idx_pos = 0
            while True:
                chunk = fea_todo[:, :, idx_pos: idx_pos + chunk_len]
                if chunk.shape[-1] == 0:
                    break
                idx_pos += chunk_len
                fea = torch.cat([fea_ref, chunk], 2).transpose(2, 1)
                cfm_res = self._vits.cfm.inference(
                    fea, torch.LongTensor([fea.size(1)]).to(fea.device),
                    mel2, sample_steps, inference_cfg_rate=0,
                )
                cfm_res = cfm_res[:, :, mel2.shape[2]:]
                mel2 = cfm_res[:, :, -T_min:]
                fea_ref = chunk[:, :, -T_min:]
                cfm_results.append(cfm_res)

            full_mel = torch.cat(cfm_results, 2)
            full_mel = _denorm_spec(full_mel)
            wav_gen = self._vocoder(full_mel)
            audio = wav_gen[0, 0].cpu().float().numpy()

        return audio  # 48 kHz mono float32


# ---------------------------------------------------------------------------
# Static config — extracted so NaiveARBackend doesn't need a private copy.
# (These values come from the GPT-SoVITS v4 training pipeline and never
#  change; bundling them with the backend keeps load-time logic local.)
# ---------------------------------------------------------------------------

_S1_CONFIG = {
    "data": {"max_sec": 54, "pad_val": 1024},
    "model": {
        "vocab_size": 1025,
        "phoneme_vocab_size": 732,
        "embedding_dim": 512,
        "hidden_dim": 512,
        "head": 16,
        "linear_units": 2048,
        "n_layer": 24,
        "dropout": 0,
        "EOS": 1024,
        "random_bert": 0,
    },
}
