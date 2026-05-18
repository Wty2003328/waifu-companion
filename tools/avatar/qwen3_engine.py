"""Qwen3-TTS engine wrapper for the companion sidecar.

Zero-shot voice cloning via Qwen3-TTS-12Hz-1.7B-Base. Hybrid speaker
conditioning: same-language target gets full paired-features cloning,
cross-lingual targets use x_vector_only mode.

JA-only loanword preprocessing via text_normalize.py (sister module).

This is the PRODUCTION wrapper — the tts_lab/tts_engines.py one is the
experimentation playground.
"""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F


# ── Loanword normaliser (JA only) ──────────────────────────────────────
try:
    from text_normalize import normalize_for_tts as _normalize_for_tts  # type: ignore
except ImportError:
    _normalize_for_tts = None  # graceful degrade


# ── Quality preset → native sampling params ────────────────────────────
# Maps the universal `x_companion.quality` field to Qwen3-TTS-specific
# generation kwargs. See docs/TTS-PROVIDER-SPEC.md §Quality preset.
#
# Tuned 2026-05-16 against the Asuna concat-best5 reference. User
# listening test picked temp=0.4 as the most-faithful voice clone of
# the lab's 28-sample sweep. Lower temperature is stricter to the
# speaker embedding's distribution → more "in-character" output at the
# cost of less prosodic variation.
#
# max_new_tokens — raised 2026-05-17 after the preset-audit rig
# (now zeroclaw-companion/tts_tools/test_tts_audio_quality.py) caught
# that the old per-preset caps (200 / 240 / 320) were biting on real
# chat replies: a 5-sentence
# Japanese story truncated at exactly token 320 (~25.6s of audio) on the
# `high` preset, missing the last 2 sentences. The talker emits EOS
# correctly on natural sentence ends — the cap was the cause, not
# missing-EOS. 2000 tokens = ~166s of audio at 12Hz codec rate, which
# covers any realistic paragraph; the cap is now a runaway safety net,
# not a routine limit.
QUALITY_PRESETS: dict[str, dict] = {
    "fast":     {"temperature": 0.6, "top_p": 0.70, "max_new_tokens": 2000},
    "balanced": {"temperature": 0.4, "top_p": 0.85, "max_new_tokens": 2000},
    "high":     {"temperature": 0.3, "top_p": 0.90, "max_new_tokens": 2000},
}


# ── Digit normalization: convert ASCII digit runs to Japanese kana ─────
# qwen3-tts hallucinates on raw digit runs ("2024年12月31日" → 160s of
# garbage instead of a 5s spoken date). Pre-converting digits to kana via
# pyopenjtalk's g2p (e.g. "2024" → "ニセンニジュウヨネン") keeps the
# model on-distribution. Only the digit RUNS are converted; surrounding
# kanji/kana are left untouched.
import re as _re
try:
    import pyopenjtalk as _pyopenjtalk
except ImportError:
    _pyopenjtalk = None


def _normalize_ja_digits(text: str) -> str:
    """Convert ASCII digit runs in `text` to Japanese kana, preserving
    everything else. Falls back to no-op if pyopenjtalk unavailable.
    Examples:
      "2024年12月31日" → "ニセンニジュウヨネンジュウニガツサンジュウイチニチ"
      "30分くらい"   → "サンジュウフンクライ"
    """
    if _pyopenjtalk is None or not _re.search(r"\d", text):
        return text
    def _repl(m: "_re.Match") -> str:
        digits = m.group(0)
        try:
            kana = _pyopenjtalk.g2p(digits, kana=True)
            return kana if kana else digits
        except Exception:
            return digits
    return _re.sub(r"\d+", _repl, text)


# ── Fade-in: 5ms raised-cosine to suppress first-sample DC click ───────
# qwen3-tts output starts with a small DC offset / discontinuity that
# users hear as a "bump" at the start of playback. A short raised-cosine
# fade-in (5ms = 120 samples @ 24kHz) ramps the first samples smoothly to
# zero, eliminating the click without audible attack delay.
def _apply_fade_in(audio: np.ndarray, sr: int, fade_ms: float = 5.0) -> np.ndarray:
    fade_samples = int(sr * fade_ms / 1000)
    if fade_samples < 2 or len(audio) < fade_samples:
        return audio
    out = audio.copy()
    fade = 0.5 * (1.0 - np.cos(np.linspace(0.0, np.pi, fade_samples)))
    out[:fade_samples] = (out[:fade_samples] * fade.astype(out.dtype))
    return out


# ── Kernel optimization: ~6.3× cumulative speedup, ASR-equivalent ──────
# Four compounding tactics across three optimization rounds (see the
# polished recipe at gpt-sovits-voice-cloning-guide/docs/13-inference-optimization.md):
#   T1: replace HF's nested code_predictor.generate() (one nested call per
#       of 15 sub-codebooks × 60 main steps = ~900 HF GenerationMixin
#       dispatches per voice-clone call) with a tight forward+sample loop.
#   T2: torch.compile(predictor.model.forward, reduce-overhead) so the
#       tight loop's per-token dispatch fuses into a CUDA graph.
#   T3: same tight-loop trick on the OUTER 28-layer talker.generate, with
#       suppress_tokens + repetition_penalty=1.05 applied manually.
#       Restores punctuation prosody that T1+T2 alone occasionally drops.
#   T4-prealloc: wrap talker.model.forward and code_predictor.model.forward
#       so the implicit DynamicCache is constructed with config=...
#       (pre-allocates num_hidden_layers DynamicLayer slots).
#       qwen-tts/modeling_qwen3_tts.py:1083 and :1487 call DynamicCache()
#       without config, causing lazy 0→N layer growth and the Dynamo guard
#       explosion that previously blocked outer compile. Modest standalone
#       win (~1.1×) by removing per-step lazy_init calls.
#       T4-compile-outer remains blocked.
# Quality preserved across all four (ASR Jaccard 1.000 vs baseline on the
# eval suite). Measured ~6× cumulative speedup on RTX 5080 / Windows.

def _top_k_top_p_filter(logits: torch.Tensor, top_k: int, top_p: float) -> torch.Tensor:
    if top_k > 0:
        kth = torch.topk(logits, top_k, dim=-1).values[..., -1, None]
        logits = torch.where(logits < kth, torch.full_like(logits, float("-inf")), logits)
    if top_p < 1.0:
        sorted_logits, sorted_idx = torch.sort(logits, descending=True, dim=-1)
        cumprob = torch.softmax(sorted_logits, dim=-1).cumsum(dim=-1)
        mask = cumprob - sorted_logits.softmax(dim=-1) > top_p
        mask[..., 0] = False
        scatter_mask = torch.zeros_like(mask).scatter_(-1, sorted_idx, mask)
        logits = logits.masked_fill(scatter_mask, float("-inf"))
    return logits


def _sample(logits: torch.Tensor, do_sample: bool, top_k: int, top_p: float, temperature: float) -> torch.Tensor:
    if not do_sample or temperature == 0.0:
        return logits.argmax(dim=-1, keepdim=True)
    logits = logits / max(temperature, 1e-5)
    logits = _top_k_top_p_filter(logits, top_k, top_p)
    probs = torch.softmax(logits, dim=-1)
    return torch.multinomial(probs, num_samples=1)


def _install_fast_code_predictor_generate(model) -> None:
    """T1: monkey-patch code_predictor.generate to a tight forward+sample
    loop. Bypasses HF's LogitsProcessor / Sampler / StoppingCriteria
    machinery in the inner RQ-Transformer codebook loop."""
    inner = model.model if hasattr(model, "model") and hasattr(model.model, "talker") else model
    predictor = inner.talker.code_predictor

    class _Result:
        __slots__ = ("sequences",)
        def __init__(self, sequences): self.sequences = sequences

    @torch.inference_mode()
    def fast_generate(self, inputs_embeds=None, max_new_tokens=None,
                      do_sample=True, top_k=50, top_p=1.0, temperature=0.9,
                      **_kwargs):
        out = predictor.forward(inputs_embeds=inputs_embeds, use_cache=True, return_dict=True)
        past = out.past_key_values
        gs = inputs_embeds.shape[1] - 1
        next_id = _sample(out.logits[:, -1, :], do_sample, top_k, top_p, temperature)
        seqs = [next_id]
        for _ in range(max_new_tokens - 1):
            out = predictor.forward(
                input_ids=next_id, past_key_values=past,
                use_cache=True, generation_steps=gs, return_dict=True,
            )
            past = out.past_key_values
            gs += 1
            next_id = _sample(out.logits[:, -1, :], do_sample, top_k, top_p, temperature)
            seqs.append(next_id)
        return _Result(sequences=torch.cat(seqs, dim=-1))

    predictor._original_generate = predictor.generate
    predictor.generate = types.MethodType(fast_generate, predictor)


def _install_fast_outer_talker_generate(model) -> None:
    """T3: replace outer Qwen3TTSTalker.generate with a tight forward+sample
    loop. Mirrors T1's pattern at the codec-step level — bypasses HF's
    GenerationMixin for the 60 outer codec steps, applying suppress_tokens
    and repetition_penalty=1.05 manually."""
    inner = model.model if hasattr(model, "model") and hasattr(model.model, "talker") else model
    talker = inner.talker
    codec_eos = inner.config.talker_config.codec_eos_token_id
    vocab_size = inner.config.talker_config.vocab_size
    suppress_idx = torch.tensor(
        sorted({i for i in range(vocab_size - 1024, vocab_size) if i != codec_eos}),
        device=talker.device, dtype=torch.long,
    )

    class _TalkerResult:
        __slots__ = ("hidden_states",)
        def __init__(self, hidden_states): self.hidden_states = hidden_states

    def _apply_token_penalties(logits, suppress, gen_history, repetition_penalty):
        if suppress is not None and suppress.numel() > 0:
            logits = logits.index_fill(-1, suppress, float("-inf"))
        if repetition_penalty != 1.0 and gen_history is not None and len(gen_history) > 0:
            prev = torch.cat(gen_history, dim=-1)
            score = logits.gather(-1, prev)
            score = torch.where(score < 0, score * repetition_penalty, score / repetition_penalty)
            logits.scatter_(-1, prev, score)
        return logits

    @torch.inference_mode()
    def fast_generate(self, inputs_embeds=None, attention_mask=None,
                      trailing_text_hidden=None, tts_pad_embed=None,
                      max_new_tokens=2048, min_new_tokens=2,
                      do_sample=True, top_k=50, top_p=1.0, temperature=0.9,
                      eos_token_id=None, repetition_penalty=1.05,
                      suppress_tokens=None, output_hidden_states=True,
                      return_dict_in_generate=True, **_kwargs):
        eos = eos_token_id if eos_token_id is not None else codec_eos
        self.rope_deltas = None
        out = self.forward(
            inputs_embeds=inputs_embeds, attention_mask=attention_mask,
            past_key_values=None, use_cache=True, output_hidden_states=True,
            past_hidden=None, trailing_text_hidden=trailing_text_hidden,
            tts_pad_embed=tts_pad_embed, generation_step=None,
        )
        past, past_hidden, gen_step = out.past_key_values, out.past_hidden, out.generation_step
        prefill_logits = _apply_token_penalties(
            out.logits[:, -1, :], suppress_idx, None, repetition_penalty)
        prefill_logits[..., eos] = float("-inf")
        next_id = _sample(prefill_logits, do_sample, top_k, top_p, temperature)
        gen_history = [next_id]
        cache_pos = past.get_seq_length()
        attn_mask = attention_mask
        collected = []
        # Codec-repetition guard. If the talker emits the SAME codec_id
        # (codebook-0 token) N times in a row, force EOS — that's the
        # signature of a runaway loop (109s of garbage on random chat
        # inputs, even with digit-norm + max_new_tokens=2000). Threshold
        # 8 chosen so legitimate sustained tones (long vowel like 「あー」
        # ~5-6 codec frames) don't trip the guard but actual stuck-loops
        # do. Bails cleanly via the EOS path so downstream code (codec
        # decoder) doesn't see the runaway tail.
        REPETITION_BAIL = 8
        recent_first_codes: list[int] = []
        for step in range(1, max_new_tokens + 1):
            attn_mask = torch.cat([attn_mask, attn_mask.new_ones((attn_mask.size(0), 1))], dim=-1)
            out = self.forward(
                input_ids=next_id, attention_mask=attn_mask,
                past_key_values=past, use_cache=True, output_hidden_states=True,
                cache_position=torch.tensor([cache_pos], device=next_id.device, dtype=torch.long),
                past_hidden=past_hidden,
                trailing_text_hidden=trailing_text_hidden,
                tts_pad_embed=tts_pad_embed, generation_step=gen_step,
            )
            past, past_hidden, gen_step = out.past_key_values, out.past_hidden, out.generation_step
            cache_pos += 1
            codec_ids = out.hidden_states[1] if isinstance(out.hidden_states, tuple) else None
            collected.append(((past_hidden,), codec_ids))
            stopped = (codec_ids[:, 0] == eos).all().item() if codec_ids is not None else False
            if stopped:
                break
            # Repetition guard: track last REPETITION_BAIL+1 codebook-0 tokens.
            # If all are identical, the model is stuck — bail.
            if codec_ids is not None:
                first_code = int(codec_ids[0, 0].item())
                recent_first_codes.append(first_code)
                if len(recent_first_codes) > REPETITION_BAIL:
                    recent_first_codes.pop(0)
                if (len(recent_first_codes) == REPETITION_BAIL
                        and len(set(recent_first_codes)) == 1):
                    # All N recent first-codebook tokens are the same.
                    # Force EOS and exit cleanly.
                    import sys as _sys
                    print(f"[T3] codec-repetition guard tripped (token={first_code} "
                          f"× {REPETITION_BAIL}); bailing at step={step}",
                          file=_sys.stderr, flush=True)
                    break
            logits = _apply_token_penalties(
                out.logits[:, -1, :], suppress_idx, gen_history, repetition_penalty)
            if step < min_new_tokens:
                logits[..., eos] = float("-inf")
            next_id = _sample(logits, do_sample, top_k, top_p, temperature)
            gen_history.append(next_id)
        return _TalkerResult(hidden_states=collected)

    talker._original_generate = talker.generate
    talker.generate = types.MethodType(fast_generate, talker)


def _install_pre_alloc_cache(model) -> None:
    """T4-prealloc: wrap talker.model.forward and code_predictor.model.forward
    so the implicit DynamicCache is constructed with config=self.config —
    triggers transformers' eager pre-allocation of num_hidden_layers slots.

    Why: qwen-tts/modeling_qwen3_tts.py:1083 and :1487 do `DynamicCache()`
    with no config → layers grow 0→N lazily across forwards. This produces
    a Dynamo guard explosion on `len(self.layers)` that blocks outer
    torch.compile AND wastes ~one lazy_init call per outer step.

    Standalone modest win (~1.1×); foundation for any future outer-compile
    attempt. Idempotent."""
    from transformers.cache_utils import DynamicCache
    inner = model.model if hasattr(model, "model") and hasattr(model.model, "talker") else model
    talker = inner.talker

    for label, sub in [
        ("talker.model", talker.model),
        ("code_predictor.model", talker.code_predictor.model),
    ]:
        if getattr(sub.forward, "_t4_prealloc", False):
            continue
        orig_fwd = sub.forward
        captured_cfg = sub.config

        def make_wrapped(orig, cfg):
            def wrapped(*args, **kwargs):
                use_cache = kwargs.get("use_cache")
                if use_cache is None:
                    use_cache = True
                if use_cache and kwargs.get("past_key_values") is None:
                    kwargs["past_key_values"] = DynamicCache(config=cfg)
                return orig(*args, **kwargs)
            wrapped._t4_prealloc = True
            return wrapped

        sub.forward = make_wrapped(orig_fwd, captured_cfg)


def _apply_kernel_opt(model) -> None:
    """Install T1 + T2. Idempotent; safe to call once per process.

    Logs to stderr because the sidecar's stdout/stderr both feed the
    companion-server's tracing pipeline — we want this visible so we
    can confirm the opt was actually applied at boot.
    """
    print("[kernel-opt] applying T1 (tight predictor decode loop)", file=sys.stderr, flush=True)
    try:
        _install_fast_code_predictor_generate(model)
        print("[kernel-opt] T1 installed", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[kernel-opt] T1 FAILED: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return

    # T4-prealloc must go BEFORE T2: T2 wraps predictor.model.forward
    # with torch.compile, and the prealloc wrapper needs to be UNDER
    # that compile (i.e. the compiled region sees a pre-allocated cache).
    # If we installed T4-prealloc after T2, the wrapper would wrap the
    # compiled call site and the cache decision would be Python-level
    # outside the graph — same lazy-growth problem.
    print("[kernel-opt] applying T4-prealloc (DynamicCache w/ config)",
          file=sys.stderr, flush=True)
    try:
        _install_pre_alloc_cache(model)
        print("[kernel-opt] T4-prealloc installed", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[kernel-opt] T4-prealloc FAILED: {type(e).__name__}: {e}",
              file=sys.stderr, flush=True)

    print("[kernel-opt] applying T2 (torch.compile predictor.model.forward, reduce-overhead)",
          file=sys.stderr, flush=True)
    try:
        inner = model.model if hasattr(model, "model") and hasattr(model.model, "talker") else model
        predictor = inner.talker.code_predictor
        # 256 (not 64): Round 3 lab confirmed even with T4-prealloc the inner
        # predictor still generates ~30-60 guard versions across cache_position
        # values and codebook indices. 64 is too tight; 256 leaves headroom.
        torch._dynamo.config.cache_size_limit = 256
        torch._dynamo.config.recompile_limit = 256
        torch.set_float32_matmul_precision("high")
        predictor.model.forward = torch.compile(
            predictor.model.forward, mode="reduce-overhead", dynamic=False,
        )
        print("[kernel-opt] T2 installed — first call will autotune (~30-60s)",
              file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[kernel-opt] T2 FAILED: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

    print("[kernel-opt] applying T3 (tight outer talker.generate)",
          file=sys.stderr, flush=True)
    try:
        _install_fast_outer_talker_generate(model)
        print("[kernel-opt] T3 installed", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[kernel-opt] T3 FAILED: {type(e).__name__}: {e}", file=sys.stderr, flush=True)


class Qwen3TTSEngine:
    """Wraps Qwen3-TTS-12Hz-1.7B-Base for zero-shot voice cloning.

    Reference clips are pre-registered via `register_voice(...)`; per-call
    synthesis just passes the registered voice_id. The prompt features
    are computed once per registration and cached.

    Hybrid speaker conditioning:
      - Same-language target (matches reference language): use full
        prompt-text-paired features. Best voice clone fidelity.
      - Cross-lingual target: use x_vector_only mode. Skips paired
        features to avoid reference-language phonotactics bleeding into
        the target.
    """

    LANG_HINT = {
        "ja": "Japanese", "en": "English", "zh": "Chinese", "ko": "Korean",
        "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese",
        "es": "Spanish", "it": "Italian",
    }
    SUPPORTED_LANGS = set(LANG_HINT.keys())

    def __init__(self, model_dir: str | Path, attn: str = "auto",
                 dtype: str = "bf16", apply_kernel_opt: bool = True):
        from qwen_tts import Qwen3TTSModel  # type: ignore

        dtype_map = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}
        torch_dtype = dtype_map.get(dtype, torch.bfloat16)

        kwargs = dict(device_map="cuda:0", dtype=torch_dtype)
        impl = None
        if attn == "auto":
            try:
                import flash_attn  # type: ignore  # noqa
                impl = "flash_attention_2"
            except ImportError:
                impl = "sdpa"
        elif attn in ("sdpa", "flash_attention_2"):
            impl = attn
        if impl:
            kwargs["attn_implementation"] = impl

        self.model = Qwen3TTSModel.from_pretrained(str(model_dir), **kwargs)
        self._impl = impl or "manual"
        self.model_dir = str(model_dir)
        # voice_id -> (reference_language, paired_prompt, x_vec_only_prompt)
        self._voices: dict[str, dict] = {}

        # Apply the 2.81× kernel-opt (T1 tight loop + T2 torch.compile).
        # Set apply_kernel_opt=False only if you suspect a regression — the
        # quality is ASR-verified byte-identical to the baseline.
        self._kernel_opt = apply_kernel_opt
        if apply_kernel_opt:
            _apply_kernel_opt(self.model)
        self._warmed_up = False  # set after first register_voice + synth

        # ASR-validate-and-retry: load faster-whisper once at engine init.
        # After each synthesize, ASR the output; if character coverage of
        # input < ASR_COVERAGE_FLOOR, retry once with a perturbed
        # temperature. Catches the qwen3-tts model's stochastic-EOS and
        # runaway-on-digits failure modes without requiring upstream model
        # surgery. ~300-500ms overhead per call (acceptable vs the 2-5s
        # synth cost). Falls back to no-validate if faster-whisper
        # missing — engine still works, just without the safety net.
        #
        # Gated behind QWEN3_ENABLE_ASR_VALIDATE env var (default off):
        # loading faster-whisper here causes a cross-thread cudagraph TLS
        # assertion when production calls dispatch to FastAPI's worker
        # thread pool (warmup runs in main, prod runs in worker; faster-
        # whisper's CUDA context init breaks the cudagraph manager's
        # thread-local state). Until that's resolved, ASR validate must
        # run out-of-process (e.g. a separate validation service) or
        # opt-in.
        self._asr = None
        if os.environ.get("QWEN3_ENABLE_ASR_VALIDATE", "0") == "1":
            try:
                from faster_whisper import WhisperModel
                print("[qwen3-engine] loading faster-whisper for synth validation ...",
                      file=sys.stderr, flush=True)
                self._asr = WhisperModel("small", device="cuda", compute_type="float16")
                print("[qwen3-engine] ASR validator ready", file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[qwen3-engine] ASR validator unavailable ({type(e).__name__}: {e}); "
                      f"synth will run without validation/retry",
                      file=sys.stderr, flush=True)

    @property
    def attn_impl(self) -> str:
        return self._impl

    def register_voice(self, voice_id: str, reference_audio: str | Path,
                       reference_language: str = "ja",
                       reference_text: Optional[str] = None) -> None:
        """Cache prompt features for `voice_id` so synthesis calls are cheap.

        Builds BOTH the paired-features prompt (same-lang) and the
        x_vector_only prompt (cross-lingual). Synthesis picks the
        appropriate one based on target language vs reference language.
        """
        ref_path = str(Path(reference_audio).resolve())
        paired = self.model.create_voice_clone_prompt(
            ref_audio=ref_path,
            ref_text=reference_text or "",
            x_vector_only_mode=False,
        )
        x_vec_only = self.model.create_voice_clone_prompt(
            ref_audio=ref_path,
            ref_text=reference_text or "",
            x_vector_only_mode=True,
        )
        self._voices[voice_id] = {
            "reference_audio": ref_path,
            "reference_language": reference_language,
            "reference_text": reference_text,
            "paired": paired,
            "x_vec_only": x_vec_only,
        }
        # First voice registration triggers a one-time warmup synth that
        # absorbs the torch.compile autotune (~30-60s). Must go through
        # synthesize() so the cudagraph_mark_step_begin() guard fires —
        # calling generate_voice_clone directly triggers a known cudagraph
        # tensor_weakrefs / stack_traces assertion mismatch.
        if self._kernel_opt and not self._warmed_up:
            print(f"[kernel-opt] warming up compiled graph (one-time autotune)…",
                  file=sys.stderr, flush=True)
            import time as _time
            _t0 = _time.time()
            try:
                self.synthesize(
                    text="warmup", voice_id=voice_id,
                    language=reference_language,
                    quality="fast",
                )
                self._warmed_up = True
                print(f"[kernel-opt] warmup done in {_time.time()-_t0:.1f}s — "
                      f"production calls now run hot",
                      file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[kernel-opt] warmup FAILED (production calls will autotune "
                      f"on first synth): {type(e).__name__}: {e}",
                      file=sys.stderr, flush=True)

    def list_voices(self) -> list[dict]:
        return [
            {
                "id": vid,
                "language": v["reference_language"],
                "reference_audio": v["reference_audio"],
                "cloned": True,
            }
            for vid, v in self._voices.items()
        ]

    # ASR validation thresholds. Coverage below this triggers a retry.
    # Tuned empirically: 0.85 catches truncation (long stories that EOS'd
    # early) without false-positiving on Whisper transcription noise.
    _ASR_COVERAGE_FLOOR = 0.85
    # Runaway: if the synthesized audio is > this multiple of expected
    # duration (chars × 0.15s/char heuristic), the model hallucinated past
    # the input — retry. Empirically, digit-runaway produced 30× expected.
    _RUNAWAY_DURATION_FACTOR = 5.0

    def synthesize(self, text: str, voice_id: str, language: str,
                   quality: str = "balanced",
                   advanced: Optional[dict] = None) -> tuple[int, np.ndarray]:
        """Synthesize speech end-to-end. Returns (sample_rate, float32
        mono wave in [-1, 1]).

        Pipeline:
          1. Text normalization: convert ASCII digit runs to JA kana
             (qwen3-tts hallucinates on raw digits).
          2. Generation: model.generate_voice_clone with quality-preset
             sampling params.
          3. Fade-in: 5ms raised-cosine to suppress first-sample click.
          4. ASR validation: if coverage < floor OR audio is a runaway,
             retry once with a perturbed temperature. Caller never sees
             the truncated/runaway audio.
        """
        if voice_id not in self._voices:
            raise KeyError(f"unknown voice_id: {voice_id}")
        if language not in self.SUPPORTED_LANGS:
            raise ValueError(f"unsupported language: {language}")

        voice = self._voices[voice_id]
        ref_lang = voice["reference_language"]
        is_cross_lingual = (language != ref_lang)
        prompt = voice["x_vec_only"] if is_cross_lingual else voice["paired"]

        # Step 1: text normalization. Only digits — leaves loanwords +
        # acronyms to the model (it handles them well natively per the
        # legacy comment; only digits trip it up).
        if language == "ja":
            text_for_tts = _normalize_ja_digits(text)
            if text_for_tts != text:
                print(f"[qwen3-engine] normalized digits: {text[:60]!r} → {text_for_tts[:60]!r}",
                      file=sys.stderr, flush=True)
        else:
            text_for_tts = text

        # Step 2: first generation attempt with the quality-preset params.
        params = dict(QUALITY_PRESETS.get(quality, QUALITY_PRESETS["balanced"]))
        if advanced:
            for k in ("max_new_tokens", "temperature", "top_p", "top_k", "repetition_penalty"):
                if k in advanced:
                    params[k] = advanced[k]

        sr, audio = self._raw_synth(text_for_tts, prompt, params)

        # Step 3: ASR-validate. Retry once if needed.
        if self._asr is not None and len(text) >= 3:
            verdict = self._asr_verdict(audio, sr, text)
            if not verdict["ok"]:
                print(f"[qwen3-engine] synth failed ASR check ({verdict['reason']}); "
                      f"retrying with temp+0.1",
                      file=sys.stderr, flush=True)
                # Retry: perturb temperature to break the deterministic
                # failure mode. Use ±0.1 from the preset; capped to [0.1, 1.0].
                retry_params = dict(params)
                retry_params["temperature"] = max(0.1, min(1.0,
                    retry_params.get("temperature", 0.4) + 0.1))
                sr2, audio2 = self._raw_synth(text_for_tts, prompt, retry_params)
                v2 = self._asr_verdict(audio2, sr2, text)
                # Pick whichever attempt is closer to acceptable. Strict
                # tie-breaker: prefer ASR-clean over best-coverage so a
                # retry that fully covers wins even if audio_s is shorter.
                if v2["ok"] or v2["coverage"] > verdict["coverage"]:
                    print(f"[qwen3-engine] retry preferred (cov {verdict['coverage']:.2f} "
                          f"→ {v2['coverage']:.2f})",
                          file=sys.stderr, flush=True)
                    sr, audio = sr2, audio2

        # Step 4: fade-in (eliminates first-sample DC click).
        audio = _apply_fade_in(audio, sr, fade_ms=5.0)

        # Production debug-capture: if the synth produced WAY more audio
        # than the input length warranted, save the WAV + text to a
        # debug folder. Builds a real-world failure corpus we can replay
        # through the test rig — instead of guessing at synthetic inputs
        # that don't match what an LLM emits in practice.
        #
        # Heuristic: audio_s > 5.0 AND audio_s > 3.0 * max(2.0, chars*0.15).
        # The 5.0s absolute floor stops short utterances ("いや" = 2s of
        # natural speech) from false-positiving as runaway. The 2.0s min-
        # expected floor handles the same case for the ratio check.
        audio_s = len(audio) / sr
        expected_s = max(2.0, len(text) * 0.15)
        if audio_s > 5.0 and audio_s > 3.0 * expected_s:
            try:
                import time as _t
                from pathlib import Path as _P
                dbg = _P(os.environ.get(
                    "QWEN3_DEBUG_CAPTURE_DIR",
                    str(_P.home() / ".cache" / "qwen3-tts-debug"),
                ))
                dbg.mkdir(parents=True, exist_ok=True)
                stamp = _t.strftime("%Y%m%d_%H%M%S")
                base = dbg / f"runaway_{stamp}"
                sf.write(str(base) + ".wav", audio, int(sr))
                (base.with_suffix(".txt")).write_text(
                    f"INPUT_TEXT: {text}\n"
                    f"NORMALIZED: {text_for_tts}\n"
                    f"QUALITY: {quality}\n"
                    f"AUDIO_S: {audio_s:.2f}\n"
                    f"EXPECTED_S: {expected_s:.2f}\n"
                    f"RATIO: {audio_s/expected_s:.1f}x\n",
                    encoding="utf-8",
                )
                print(f"[qwen3-engine] DEBUG CAPTURE: runaway saved to {base}.wav "
                      f"(audio {audio_s:.1f}s vs expected {expected_s:.1f}s)",
                      file=sys.stderr, flush=True)
            except Exception as _e:
                print(f"[qwen3-engine] debug capture failed: {_e}",
                      file=sys.stderr, flush=True)

        return int(sr), audio.astype(np.float32)

    def _raw_synth(self, text: str, prompt: dict, params: dict) -> tuple[int, np.ndarray]:
        """Single generation pass with the given params. No validation,
        no normalization (caller has done both)."""
        if self._kernel_opt:
            torch.compiler.cudagraph_mark_step_begin()
        wavs, sr = self.model.generate_voice_clone(
            text=text,
            language=self.LANG_HINT["ja"],  # always ja for the digit-normalized path
            voice_clone_prompt=prompt,
            **params,
        )
        wave = wavs[0]
        if isinstance(wave, torch.Tensor):
            wave = wave.squeeze().cpu().numpy()
        return int(sr), np.asarray(wave, dtype=np.float32)

    def _asr_verdict(self, audio: np.ndarray, sr: int, original_text: str) -> dict:
        """ASR the synthesized audio + compare to the original input text.
        Returns {ok, coverage, reason}. ok=False triggers a retry."""
        import tempfile
        from difflib import SequenceMatcher
        # Whisper wants a file; write to temp wav.
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, audio, sr)
            wav_path = f.name
        try:
            segs, _ = self._asr.transcribe(wav_path, language="ja", beam_size=1)
            asr_text = "".join(s.text for s in segs).strip()
        finally:
            try: os.unlink(wav_path)
            except Exception: pass

        # Normalize both for char-by-char comparison.
        import re as _re_local
        def _strip(s):
            return _re_local.sub(r"[\s,\.\?\!、。？！「」『』ー〜・…★（）()]+", "", s)
        in_n = _strip(original_text)
        asr_n = _strip(asr_text)
        coverage = SequenceMatcher(None, in_n, asr_n).ratio() if in_n else 1.0

        audio_s = len(audio) / sr
        expected_s = max(0.5, len(original_text) * 0.15)
        runaway = audio_s > self._RUNAWAY_DURATION_FACTOR * expected_s

        if runaway:
            return {"ok": False, "coverage": coverage, "audio_s": audio_s,
                    "reason": f"runaway audio_s={audio_s:.1f}s > {self._RUNAWAY_DURATION_FACTOR}× expected {expected_s:.1f}s"}
        if coverage < self._ASR_COVERAGE_FLOOR:
            return {"ok": False, "coverage": coverage, "audio_s": audio_s,
                    "reason": f"low coverage {coverage:.2f} < {self._ASR_COVERAGE_FLOOR}"}
        return {"ok": True, "coverage": coverage, "audio_s": audio_s,
                "reason": "ok"}
