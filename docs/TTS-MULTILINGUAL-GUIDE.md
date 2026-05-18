# TTS — multilingual voice cloning guide (2026)

A survey of open multilingual zero-shot TTS models for character voice
cloning, the path we tried that didn't work, and the architecture we
chose. Source for both the avatar pipeline and any future TTS work in
this project.

## TL;DR

- The companion's TTS goal is one voice (Asuna) speaking **ja / en / zh**
  with high quality. Korean and Cantonese were de-prioritised after
  evidence showed they raise project cost without clear user demand.
- The 2023-era stack (GPT-SoVITS v4 + per-language LoRA + RVC-generated
  training data) is a **structural dead end** for cross-lingual quality.
  See [§Why GPT-SoVITS+LoRA+RVC fails](#why-gpt-sovitslorarvc-fails).
- The 2026 SOTA path is a zero-shot voice-clone model with a properly
  pretrained multilingual base. We picked **Qwen3-TTS-12Hz-1.7B-Base**
  (Alibaba, January 2026, Apache-2.0) on the basis of a 33-case
  robustness eval against an Asuna reference clip.
- This doc covers the landscape, why we picked Qwen3-TTS, and the
  integration recipe. The old GPT-SoVITS retraining stages are
  **deleted**; do not resurrect them without reading this doc.

## Why GPT-SoVITS+LoRA+RVC fails

The previous approach was:

1. Train a GPT-SoVITS LoRA on ~168 Japanese Asuna clips → great JA quality
2. Make non-JA training data by running ZH source audio through an RVC
   voice converter (trained on Asuna) to produce "Asuna-voice ZH" clips
3. Retrain the LoRA on JA + RVC-converted ZH → expect ZH ability

Multiple failure modes compound here:

- **Kanji-bleed bug (field-wide, not a data problem).** GPT-SoVITS's
  text frontend doesn't disambiguate kanji that exist in both JA and ZH.
  The CosyVoice 3 paper ([arxiv 2505.17589](https://arxiv.org/pdf/2505.17589))
  documents this as a generic SOTA-blocker that they fixed by
  pre-converting JA text to katakana before tokenisation. Without that
  fix, any same-base model leaks JA prosody into ZH output. **No amount
  of fine-tuning data fixes this; the bug is in the tokeniser.**
- **RVC quality ceiling.** RVC inference uses a HuBERT content encoder
  trained on a single language; running ZH source audio through a
  `japanese-hubert-base` content encoder destroys ZH phonetic content
  enough that 36% of converted clips have <0.5 jaccard to the source
  transcript on ASR back-transcription. Training data this noisy
  teaches the TTS model that text and audio are loosely associated.
- **Synthetic-data circularity.** Using a JA-only voice converter to
  make ZH training data is bootstrapping ZH from JA — errors compound.
  The only way around it is a real ZH-native speaker, at which point
  the voice has drifted from Asuna anyway.

The combined ceiling we measured: **35% pass rate** on the 46-case
robustness eval. ZH was stuck at 0/10 across every retraining stage.
The retraining itself worked (loss converged to 0.00014), but the
ceiling is set by the data and the tokeniser, not the optimiser.

## The 2026 landscape

Open multilingual zero-shot TTS in May 2026 looks like this:

| Model | Released | Params | Langs | Notes |
|-------|----------|--------|-------|-------|
| **Qwen3-TTS-12Hz-1.7B-Base** | Jan 2026 | 1.7B | 10 (ZH/EN/JA/KO/DE/FR/RU/PT/ES/IT) | **Picked.** Best ja/en/zh out-of-box quality on Asuna ref clip. Apache-2.0. |
| Fun-CosyVoice3-0.5B-2512 | Dec 2025 | 0.5B | 9 + 18 Chinese dialects (incl. Cantonese) | Explicitly fixed JA-script-leakage; broken text frontend in our env (needs proprietary ttsfrd). |
| IndexTTS-2 | Sep 2025 | 1.5B | ZH/EN/JA only | Best anime expressiveness. No KO. |
| Higgs Audio v2.5 | 2025 | 1B distill | 20+ (no Cantonese) | Strong cross-lingual identity preservation. |
| Chatterbox Multilingual (Resemble) | 2025 | ~1B | 23 langs (no Cantonese) | `cfg_weight=0.0` accent-bleed knob; #1 TTS-Arena cloning. |
| F5-TTS / Cross-Lingual F5-TTS | 2024-25 | 0.3B | EN/ZH-trained, JA generalises | Tiny (3GB VRAM); JA quality only "comparable to F5-TTS". |
| VibeVoice (Microsoft) | 2025 | 1.5B | JA/KO/ZH | Long-form (90 min) focus; research-licensed. |
| XTTS-v2 (Coqui) | 2023 | 0.4B | 17 | Surpassed by all of the above. Avoid. |

All are open-weights. All fit in 24GB VRAM. Most fit in 16GB.

## Why Qwen3-TTS

The 33-case robustness eval (`tts_lab/run_eval.py`) was the decider.
Two models were tested with the same Asuna reference clip:

- **Qwen3-TTS:** worked on the first inference call. EN: literal exact
  match to gold. JA: ~99% match. ZH: ~70% on a hard sentence containing
  the four-character idiom "人工智能". No tuning, no debugging.
- **CosyVoice 3:** model loads, audio decoder emits fluent speech in
  the right language, but the content doesn't match the input text —
  produces unrelated Chinese phrases when given Asuna-cloned ZH. The
  text frontend (TN) layer fails. CosyVoice 3 ships with a proprietary
  `ttsfrd` resource that's not in the HuggingFace download; the
  `wetext` fallback doesn't produce correct tokens for our env.
  Fixable in principle, blocking in practice.

Qwen3-TTS's choices that make it the right fit:

- **Discrete multi-codebook LM** architecture means voice identity is
  encoded in a language-agnostic speaker embedding extracted from the
  reference clip; the text path is decoupled.
- **Qwen3-TTS-Tokenizer-12Hz** is the speech codec; the model is a
  Qwen3 LLM finetuned to produce speech tokens. This means the text
  encoder is a true LLM, not a phoneme tokeniser — it handles digits,
  acronyms, mixed scripts, and OOD phrases via the same generalisation
  that text LLMs have.
- **3-second voice clone.** No fine-tuning, no LoRA, no per-character
  training. Hand the model an Asuna WAV at inference time and it
  speaks in her voice.
- **Apache-2.0 license.**

The user-stated priority languages (ja/en/zh) are all in Qwen3-TTS's
core 10. Korean works too (we measured ~80% on a sample sentence) but
is not a project goal. Cantonese is **not supported**; if it becomes a
requirement, we'd need to either (a) revisit CosyVoice 3 with the
proprietary frontend or (b) accept that yue uses Mandarin pronunciation.

## Reference clip

The voice identity comes entirely from the reference clip passed at
inference. Picking it well is the most consequential single choice:

- **Length:** 3-30 seconds. Qwen3-TTS docs say "3 seconds" but longer,
  multi-clip references give the speaker encoder a richer fingerprint.
  We use ~32s (5 clips concatenated). Verified ceiling: ~49s starts to
  cause AR hallucinations; **cap at 32s**.
- **Cleanliness:** no background music, no overlapping speakers, no
  excessive emotion (the model picks up emotion AND timbre).
- **Diversity:** within the same speaker, span declarative + questioning
  + conversational prosody so the model's speaker fingerprint is rich.
- **Transcript:** must accompany the clip. The model uses the
  transcript to compute prompt features that help it pronounce the
  *target* text correctly.

The chosen Asuna reference is `tts_lab/reference_clips/asuna_concat_diverse5.wav`
— a 31-second concatenation of 5 prosody-diverse clips with 0.3s
silence gaps. **Diversity matters more than raw audio quality** —
earlier monologue-only references over-emoted on casual targets
("こんにちは...", "うん、わかった").

| Clip | Role |
|------|------|
| 0042 | declarative (top audio-quality score) |
| 0072 | narrative (user favourite) |
| 0035 | questioning (user favourite) |
| 0032 | casual whining ("もう、そんなにねほりはほり…") |
| 0001 | energetic short bursts ("チャレンジ! チャレンジ!") |

The mix gives the speaker encoder a matching prosodic attractor for
every target-text mood. Built by `tts_lab/build_best_reference.py` +
the diverse5 selection logic. Final A/B winner over `best5`
(user-favourites only) and `quality` (audio-metric-only). The
selection was the result of a multi-round listening test:

1. 19 single-clip + 12 multi-clip refs (round 1 picked best5)
2. 28 sampling-knob variants on best5 (round 2 picked temp=0.4)
3. 6 best5-vs-quality A/B (round 3 — quality more natural, casual flat)
4. 4 diverse5 sentences (round 4 — winner: diverse5)

**Sampling tuning:** the production "balanced" quality preset uses
`temperature=0.4, top_p=0.85` — also user-picked from a 28-sample
listening test sweeping temperature, top_p, and repetition_penalty.
Lower temperature is stricter to the speaker embedding's distribution
→ more in-character, less prosodic drift.

**Text normalisation: OFF for Qwen3-TTS.** The legacy
`tools/avatar/text_normalize.py` layer (alkana corpus + ARPAbet →
katakana adapter) was carried over from the GPT-SoVITS era — it was
needed there because GPT-SoVITS's tokeniser can't handle Latin
loanwords in JA text. Qwen3-TTS has a real LLM as its text encoder
and handles "iPhone" / "GitHub" / "API" natively, producing canonical
JA pronunciations (アイフォン / ギットハブ / エーピーアイ). Verified
empirically: when we kept the normalizer enabled, it produced
incorrect katakana ("イフォウン" for iPhone) that the model dutifully
spoke. Disabling the normalizer reverted to native LLM handling and
fixed all loanword/acronym cases. The `text_normalize.py` file stays
in the codebase for the GPT-SoVITS fallback path and any future
backend with a weaker text frontend, but Qwen3-TTS sidecar bypasses
it.

## Integration recipe

At a high level, the companion's avatar TTS path becomes:

```
text → (text_normalize.py preprocess) → Qwen3TTSModel.generate_voice_clone(
   text=text,
   language=language_name,
   voice_clone_prompt=cached_asuna_prompt,
) → 24 kHz wav → avatar audio out
```

**Cached prompt:** call `model.create_voice_clone_prompt(ref_audio, ref_text)`
**once** at startup; reuse for every synthesis. This skips per-call
feature extraction.

**Sidecar pattern:** the avatar already uses a TTS sidecar on port
9890 with `/tts` and `/health` endpoints (see
[crates/companion-avatar/src/tts_server.rs](../crates/companion-avatar/src/tts_server.rs)).
The integration is a drop-in replacement: new sidecar with the same
HTTP API, backed by Qwen3-TTS.

**Hardware target:** 5080 16GB. Qwen3-TTS-1.7B-Base runs in ~4 GB
VRAM at bfloat16. Leaves 12 GB for everything else.

**Languages list:** the existing `text_normalize.py` covers JA/EN/ZH
input cleanup. The model handles its own grapheme-to-phoneme. We pass
through preprocessing as a defence layer (strips garbage chars,
normalizes special punctuation) but the heavy lifting moves to the
model.

## Robustness eval

The 46-case eval (now 33 cases for ja/en/zh scope) lives at
`tts_lab/run_eval.py` and reuses the case definitions from
`tts_tools/tts_robustness_eval.py`. Each case has a target text + gold
language + min length-ratio + min jaccard threshold. Each pass
through:

1. Engine synthesizes the target text using Asuna reference
2. faster-whisper transcribes the output
3. Compute jaccard + length-ratio between gold text and ASR result
4. Pass iff jaccard ≥ threshold AND length_ratio in [min, max]

Acceptance bar before porting to the companion: **≥80% overall pass
rate** with **no language at 0%**. Final tuning iterates the reference
clip choice + Qwen3-TTS sampling params if needed.

## What we threw away

- **All retrain_stage1/2/3 scripts.** Deleted from `tts_tools/`.
- **The 10 retrained `asuna_multilang` LoRA checkpoints.** Worse than
  baseline on every language except KO. Deleted.
- **The 2500 RVC-converted ZH clips.** ~1.4 GB. Deleted.
- **The `asuna_rvc` RVC model.** ~5.9 GB. Deleted.
- **The `asuna_multilang` preprocessed GPT-SoVITS dataset.** ~2.4 GB.
  Deleted.

Total reclaimed: ~10.4 GB. The original 168 Asuna JA clips
(`GPT-SoVITS/logs/asuna_combined/0_sliced/`) **stay** — they're the
source of reference clips for the new pipeline.

The original Asuna LoRA (`asuna_combined_e15_s1290_l16.pth` and
siblings) **stays for now** as the production JA fallback. It is
swapped out during the avatar port (Task #98).

## Related docs

- [TESTING-SOP.md](TESTING-SOP.md) — test layering for avatar changes
- `tts_lab/` — the standalone playground; tts_engines.py, run_eval.py
- Qwen3-TTS [model card](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base)
  and [GitHub](https://github.com/QwenLM/Qwen3-TTS)
