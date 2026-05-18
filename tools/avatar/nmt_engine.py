"""Small-NMT translation engine for the companion's avatar subagent.

The companion's avatar subagent currently calls a chat LLM
(glm-4.5-flash) to translate each streamed sentence from the chat
language into the TTS speech language. That LLM round-trip is
~700-1000 ms per sentence even with thinking disabled, and the
latency lands on the critical path between "user submits" and "user
hears audio".

A dedicated neural-MT model translates the same sentence in
~100 ms (small) to ~1 s (large) on CPU, sub-second on GPU. The
output is more literal — translation models don't render anime-girl
casual register the way a prompted LLM can — so this is offered as a
backend *option*, not a default. The companion picks at config time:

    [avatar.subagent.translator]
    backend = "http"
    url = "http://127.0.0.1:9881"

This module owns the model side: loading, translation, shutdown. No
HTTP. `nmt_translator_server.py` wraps an instance in a FastAPI app.

## Model selection

The engine exposes a **quality preset** that picks a sensible
(model, beams, precision) combination plus an **explicit override**
for power users. Presets, from fastest to highest quality:

| Preset      | Model                              | Params | CPU lat | Quality        |
|-------------|------------------------------------|--------|---------|----------------|
| `fast`      | `staka/fugumt-en-ja`               | ~70M   | ~100 ms | decent modern  |
| `balanced`  | `facebook/nllb-200-distilled-600M` | 600M   | ~400 ms | strong, multi  |
| `quality`   | `facebook/nllb-200-distilled-1.3B` | 1.3B   | ~1-2 s  | very good      |
| `custom`    | <NMT_MODEL_ID>                     | —      | —       | user override  |

Default is `balanced`: NLLB-200-distilled-600M is the best
quality/latency balance for chat. fugumt is faster but en-ja only and
sometimes too literal; 1.3B is a real upgrade when quality matters
and you can afford the latency or have a GPU. NLLB-3.3B was dropped —
the +1.5–2.5 BLEU gain over 1.3B isn't worth the 3–5× latency and 2×
VRAM for short conversational sentences.

## Backends

Two model architectures ship:

- [`MarianBackend`]: Helsinki-NLP `opus-mt-*` and community Marian
  models (fugumt). Per-pair, smallest.
- [`NLLBBackend`]: Meta NLLB-200 family. Multilingual via flores codes,
  no per-pair model swap.

The factory picks the backend from the resolved model id.
"""

from __future__ import annotations

import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol

# ---------------------------------------------------------------------------
# Import-time env. Kept minimal because, unlike the TTS engine, NMT
# may need to *download* model weights on first run — so we don't force
# HF_HUB_OFFLINE here. Set it manually after first successful load
# if you want to guarantee no network on subsequent starts.
# ---------------------------------------------------------------------------

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


# ---------------------------------------------------------------------------
# Quality presets
# ---------------------------------------------------------------------------

# Each preset is (model_id, num_beams, suggested-device-note). The
# beam counts match each model's published-best recipe; tighter beams
# are faster but lose quality.
PRESETS: dict[str, dict[str, object]] = {
    "fast": {
        "model_id": "staka/fugumt-en-ja",
        "num_beams": 4,
        "description": "Small Marian model specialized for en→ja. "
                       "~70M params, ~100 ms CPU. Decent modern JA. "
                       "en→ja only (ignores src/tgt config for other pairs).",
    },
    "balanced": {
        "model_id": "facebook/nllb-200-distilled-600M",
        "num_beams": 5,
        "description": "NLLB-200 distilled-600M. Multilingual, ~400 ms CPU. "
                       "Strong default — supports 200 languages, "
                       "production-grade quality.",
    },
    "quality": {
        "model_id": "facebook/nllb-200-distilled-1.3B",
        "num_beams": 5,
        "description": "NLLB-200 distilled-1.3B. ~1-2 s CPU / ~200 ms GPU. "
                       "Noticeable quality jump over 600M; recommended when "
                       "you have a GPU or can tolerate the CPU latency. "
                       "Top tier — NLLB-3.3B was dropped (marginal gain, "
                       "3-5x latency, 2x VRAM).",
    },
}

DEFAULT_PRESET = "balanced"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass
class TranslatorConfig:
    """All inputs the engine needs. Build via `from_env()` for the
    standard companion-driven launch, or construct directly for tests.

    Quality / performance / model / hardware are all exposed as
    separate fields so the user can tune any axis independently."""

    # ----- Quality axis -----
    # Preset → (model, beams). Override with `model_id` for explicit
    # control. `num_beams` overrides the preset's beam count.
    quality_preset: str = DEFAULT_PRESET
    # Explicit override; takes priority over the preset.
    model_id: Optional[str] = None
    # 1 = greedy (fastest, worse), 5-8 = high-quality. Defaults to the
    # preset's pick when None.
    num_beams: Optional[int] = None

    # ----- Hardware axis -----
    device: str = "cpu"           # "cpu" | "cuda" | "cuda:N"
    precision: str = "auto"       # "auto" | "fp32" | "fp16" | "bf16"

    # ----- Language axis -----
    src_lang: str = "en"
    tgt_lang: str = "ja"

    # ----- Safety / runtime -----
    # Max generated tokens per call. 256 covers ~5-8 short JA sentences
    # (typical chatbot reply). The previous default of 96 truncated
    # longer replies — last sentence missing was the symptom. Raise via
    # NMT_MAX_NEW_TOKENS env if your chat replies routinely exceed this.
    max_new_tokens: int = 256

    @classmethod
    def from_env(cls) -> "TranslatorConfig":
        preset = os.environ.get("NMT_QUALITY_PRESET", DEFAULT_PRESET).lower()
        if preset not in PRESETS and preset != "custom":
            print(
                f"[nmt-engine] WARN: unknown preset {preset!r}; "
                f"falling back to {DEFAULT_PRESET!r}. "
                f"Available: {list(PRESETS) + ['custom']}"
            )
            preset = DEFAULT_PRESET
        return cls(
            quality_preset=preset,
            model_id=os.environ.get("NMT_MODEL_ID") or None,
            num_beams=_optional_int_env("NMT_NUM_BEAMS", minimum=1, maximum=12),
            device=os.environ.get("NMT_DEVICE", "cpu"),
            precision=os.environ.get("NMT_PRECISION", "auto").lower(),
            src_lang=os.environ.get("NMT_SRC_LANG", "en"),
            tgt_lang=os.environ.get("NMT_TGT_LANG", "ja"),
            max_new_tokens=_int_env("NMT_MAX_NEW_TOKENS", 256, minimum=8, maximum=1024),
        )

    def resolve_model_id(self) -> str:
        if self.model_id:
            return self.model_id
        if self.quality_preset == "custom":
            raise SystemExit(
                "NMT_QUALITY_PRESET=custom requires NMT_MODEL_ID to be set."
            )
        preset = PRESETS[self.quality_preset]
        return str(preset["model_id"])

    def resolve_num_beams(self) -> int:
        if self.num_beams is not None:
            return self.num_beams
        if self.quality_preset == "custom":
            return 4  # Reasonable default for unknown models.
        return int(PRESETS[self.quality_preset]["num_beams"])  # type: ignore[arg-type]


def _int_env(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        v = int(raw)
    except ValueError:
        return default
    return max(minimum, min(maximum, v))


def _optional_int_env(name: str, *, minimum: int, maximum: int) -> Optional[int]:
    raw = os.environ.get(name)
    if raw is None:
        return None
    try:
        v = int(raw)
    except ValueError:
        return None
    return max(minimum, min(maximum, v))


# ---------------------------------------------------------------------------
# Backend protocol
# ---------------------------------------------------------------------------


class TranslationBackend(Protocol):
    def translate(self, text: str, *, src_lang: Optional[str] = None) -> str: ...

    @property
    def model_id(self) -> str: ...

    @property
    def backend_kind(self) -> str: ...

    def supports_src_lang_override(self) -> bool: ...


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _resolve_device(device_str: str):
    import torch
    s = device_str.lower().strip()
    if s.startswith("cuda") and not torch.cuda.is_available():
        print(f"[nmt-engine] {s!r} requested but CUDA unavailable; falling back to cpu")
        s = "cpu"
    return torch.device(s)


def _resolve_dtype(precision: str, device):
    """Map `precision` to a torch dtype, with sane fall-through:
    `auto` → fp16 on GPU, fp32 on CPU (CPU fp16 is slower without AVX
    half-precision support on most x86 CPUs)."""
    import torch
    p = precision.lower().strip()
    on_gpu = device.type == "cuda"
    if p == "auto":
        return torch.float16 if on_gpu else torch.float32
    return {
        "fp32": torch.float32,
        "fp16": torch.float16,
        "bf16": torch.bfloat16,
    }.get(p, torch.float32)


# `opus-mt-*-jap` models emit SentencePiece token boundaries as ASCII
# spaces between JA chars ("私 の 名 前 …"). Collapse a space whose
# neighbours are both non-Latin so Latin spacing stays intact.
_CJK_GAP_RE = re.compile(r"(?<=[^\x00-\x7f])\s+(?=[^\x00-\x7f])")


def _strip_cjk_spaces(text: str) -> str:
    return _CJK_GAP_RE.sub("", text).strip()


# ---------------------------------------------------------------------------
# Marian backend (opus-mt, fugumt)
# ---------------------------------------------------------------------------


class MarianBackend:
    """Helsinki-NLP `opus-mt-*` and community Marian models like
    `staka/fugumt-*`. Tiny, fast, per-pair. The model id is pinned
    at construct time; the request-time src/tgt langs are advisory."""

    def __init__(self, config: TranslatorConfig):
        import torch
        from transformers import MarianMTModel, MarianTokenizer

        self._device = _resolve_device(config.device)
        self._dtype = _resolve_dtype(config.precision, self._device)
        self._model_id = config.resolve_model_id()
        self._num_beams = config.resolve_num_beams()
        self._max_new_tokens = config.max_new_tokens

        print(
            f"[nmt-engine] Marian: loading {self._model_id} on "
            f"{self._device} (dtype={self._dtype}, beams={self._num_beams})"
        )
        t0 = time.time()
        self._tokenizer = MarianTokenizer.from_pretrained(self._model_id)
        model = MarianMTModel.from_pretrained(self._model_id)
        if self._dtype != torch.float32:
            model = model.to(self._dtype)
        self._model = model.to(self._device).eval()
        self._torch = torch
        print(f"[nmt-engine]   loaded in {time.time() - t0:.2f}s")

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def backend_kind(self) -> str:
        return "marian"

    def supports_src_lang_override(self) -> bool:
        # Marian models are pair-pinned at construct time (one model
        # per direction). Per-request src_lang is meaningless here.
        return False

    def translate(self, text: str, *, src_lang: Optional[str] = None) -> str:
        if not text.strip():
            return ""
        # `src_lang` is intentionally ignored — see supports_src_lang_override.
        # The server logs a warning when it's set but ignored.
        del src_lang
        with self._torch.inference_mode():
            inputs = self._tokenizer(
                text, return_tensors="pt", truncation=True, max_length=512,
            ).to(self._device)
            out = self._model.generate(
                **inputs,
                num_beams=self._num_beams,
                max_new_tokens=self._max_new_tokens,
                early_stopping=True,
            )
            decoded = self._tokenizer.decode(out[0], skip_special_tokens=True)
        return _strip_cjk_spaces(decoded)


# ---------------------------------------------------------------------------
# NLLB-200 backend
# ---------------------------------------------------------------------------

# Flores-200 language codes used by NLLB. Map ISO-2 → flores. We list
# the common pairs the companion is likely to use; unknown codes are
# passed through as-is so users can supply flores codes directly.
_FLORES_LANG: dict[str, str] = {
    "en": "eng_Latn",
    "ja": "jpn_Jpan",
    "zh": "zho_Hans",      # simplified by default
    "zh-Hant": "zho_Hant",
    "ko": "kor_Hang",
    "fr": "fra_Latn",
    "es": "spa_Latn",
    "de": "deu_Latn",
    "ru": "rus_Cyrl",
    "ar": "arb_Arab",
    "pt": "por_Latn",
    "it": "ita_Latn",
    "vi": "vie_Latn",
    "th": "tha_Thai",
    "hi": "hin_Deva",
}


def _flores_code(lang: str) -> str:
    """ISO-2 → flores-200. Pass-through for explicit flores codes
    (they always contain an underscore)."""
    if "_" in lang:
        return lang
    return _FLORES_LANG.get(lang, lang)


class NLLBBackend:
    """Meta `facebook/nllb-200-*` multilingual MT.

    Supports 200 languages via flores-200 codes. The companion's
    config uses 2-letter ISO codes (`en` / `ja`); this backend
    transparently maps them to flores."""

    def __init__(self, config: TranslatorConfig):
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        self._device = _resolve_device(config.device)
        self._dtype = _resolve_dtype(config.precision, self._device)
        self._model_id = config.resolve_model_id()
        self._num_beams = config.resolve_num_beams()
        self._max_new_tokens = config.max_new_tokens
        self._src_code = _flores_code(config.src_lang)
        self._tgt_code = _flores_code(config.tgt_lang)

        print(
            f"[nmt-engine] NLLB: loading {self._model_id} on "
            f"{self._device} (dtype={self._dtype}, beams={self._num_beams}, "
            f"{self._src_code}→{self._tgt_code})"
        )
        t0 = time.time()
        self._tokenizer = AutoTokenizer.from_pretrained(
            self._model_id, src_lang=self._src_code,
        )
        model = AutoModelForSeq2SeqLM.from_pretrained(self._model_id)
        if self._dtype != torch.float32:
            model = model.to(self._dtype)
        self._model = model.to(self._device).eval()
        # Resolve the target-language forced BOS token once.
        # NLLB requires `forced_bos_token_id` to switch decode language.
        tgt_token = self._tokenizer.convert_tokens_to_ids(self._tgt_code)
        if tgt_token is None or tgt_token == self._tokenizer.unk_token_id:
            raise SystemExit(
                f"NLLB does not recognise target language {self._tgt_code!r}. "
                "Check the flores-200 code list."
            )
        self._forced_bos = tgt_token
        self._torch = torch
        print(f"[nmt-engine]   loaded in {time.time() - t0:.2f}s")

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def backend_kind(self) -> str:
        return "nllb"

    def supports_src_lang_override(self) -> bool:
        # NLLB is multilingual — src/tgt are flores codes the tokenizer
        # uses to drive language-specific encoding. Both are flippable
        # per call.
        return True

    def translate(self, text: str, *, src_lang: Optional[str] = None) -> str:
        if not text.strip():
            return ""
        # NLLB tokenizes language-aware: changing tokenizer.src_lang
        # routes the input through the right vocabulary slice. Without
        # this, an input in language X with src_lang set to Y produces
        # tokenization garbage and a broken translation. Cheap to flip
        # per call (the tokenizer just looks up a code).
        if src_lang:
            self._tokenizer.src_lang = _flores_code(src_lang)
        else:
            self._tokenizer.src_lang = self._src_code
        with self._torch.inference_mode():
            inputs = self._tokenizer(
                text, return_tensors="pt", truncation=True, max_length=512,
            ).to(self._device)
            out = self._model.generate(
                **inputs,
                forced_bos_token_id=self._forced_bos,
                num_beams=self._num_beams,
                max_new_tokens=self._max_new_tokens,
                early_stopping=True,
            )
            decoded = self._tokenizer.decode(out[0], skip_special_tokens=True)
        return decoded.strip()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def _pick_backend_cls(model_id: str) -> type:
    """Pick a backend class from the resolved model id. Pattern-based:
    NLLB ids start with `facebook/nllb-`; everything else is Marian
    (covers opus-mt-* and the staka/fugumt-* family)."""
    if model_id.startswith("facebook/nllb-"):
        return NLLBBackend
    # mBART / M2M100 / Aya would each be their own backend class once
    # someone wants them. Marian covers the small + popular cases today.
    return MarianBackend


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class NMTEngine:
    """Owns a translation backend instance. Public surface is
    `translate`, `warmup`, `shutdown`. Serial-only — translators are
    not designed for concurrent use within a process."""

    def __init__(self, config: TranslatorConfig):
        self.config = config
        model_id = config.resolve_model_id()
        backend_cls = _pick_backend_cls(model_id)
        self._backend: TranslationBackend = backend_cls(config)
        self._cleanup_done = False

    @property
    def backend_name(self) -> str:
        return self._backend.backend_kind

    @property
    def model_id(self) -> str:
        return self._backend.model_id

    @property
    def quality_preset(self) -> str:
        return self.config.quality_preset

    def translate(self, text: str, *, src_lang: Optional[str] = None) -> str:
        return self._backend.translate(text, src_lang=src_lang)

    @property
    def supports_src_lang_override(self) -> bool:
        return self._backend.supports_src_lang_override()

    def warmup(self) -> float:
        sample = "Hello, this is a warmup sentence."
        t0 = time.time()
        try:
            self.translate(sample)
        except Exception as e:
            print(f"[nmt-engine] warmup failed (continuing): {e!r}")
            return time.time() - t0
        elapsed = time.time() - t0
        print(f"[nmt-engine] warmup done in {elapsed:.2f}s")
        return elapsed

    def shutdown(self) -> None:
        if self._cleanup_done:
            return
        self._cleanup_done = True
        try:
            self._backend = None  # type: ignore[assignment]
            import torch
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
            print("[nmt-engine] cleanup done")
        except Exception as e:
            print(f"[nmt-engine] cleanup error (continuing): {e}")
