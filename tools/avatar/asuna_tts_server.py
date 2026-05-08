"""Reference TTS-port wrapper for the Asuna GPT-SoVITS v4 fine-tune.

Speaks the model-agnostic ZeroClaw avatar TTS contract:

    POST /tts   {"text": "...", "language": "ja", "voice": "...", "speed": 1.0}
                -> WAV bytes (with X-Sample-Rate / X-Channels / X-Format headers)
    GET  /health
                -> 200 OK once the model is loaded

Anyone can swap models by writing a similar wrapper that conforms to the
same contract. Configure ZeroClaw with:

    [avatar.tts]
    engine          = "gpt-sovits-v4"
    launch_command  = "python tools/avatar/asuna_tts_server.py"
    port            = 9880
    voice           = "asuna"
    reference_audio = "C:/Users/.../GPT-SoVITS/logs/asuna_combined/0_sliced/0003.wav"
    reference_text  = "ここは私に任せて私を選んでくれる"
    reference_language = "ja"
    language        = "ja"   # default speech language
    auto_start      = true
    gpu_device      = 0

Env vars set by ZeroClaw (all optional — script has sane defaults):
    TTS_PORT, TTS_VOICE, TTS_LANGUAGE,
    TTS_REFERENCE_AUDIO, TTS_REFERENCE_TEXT, TTS_REFERENCE_LANG,
    TTS_MODEL_PATH (= GPT-SoVITS root), CUDA_VISIBLE_DEVICES.

Run standalone for testing:
    python tools/avatar/asuna_tts_server.py
"""

import io
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import uvicorn


# ---------------------------------------------------------------------------
# Locate the GPT-SoVITS install. TTS_MODEL_PATH points at the repo root.
# ---------------------------------------------------------------------------

GPT_SOVITS_ROOT = Path(
    os.environ.get(
        "TTS_MODEL_PATH",
        r"C:\Users\user\Desktop\workspace\GPT-SoVITS",
    )
).resolve()

if not GPT_SOVITS_ROOT.exists():
    raise SystemExit(f"GPT-SoVITS root not found: {GPT_SOVITS_ROOT}")

os.chdir(str(GPT_SOVITS_ROOT))
sys.path.insert(0, str(GPT_SOVITS_ROOT))
sys.path.insert(0, str(GPT_SOVITS_ROOT / "GPT_SoVITS"))

# ffmpeg from the conda env (matches train scripts).
ffmpeg_bin = str(Path(r"E:/miniconda/envs/ece598/Scripts"))
os.environ["PATH"] = ffmpeg_bin + os.pathsep + os.environ.get("PATH", "")
os.environ["version"] = "v4"


# ---------------------------------------------------------------------------
# Model loading — mirrors test_v4_inference.py.
# Done once at process start. The /tts handler reuses these tensors.
# ---------------------------------------------------------------------------

DEVICE = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
CNHUBERT_PATH = str(GPT_SOVITS_ROOT / "GPT_SoVITS" / "pretrained_models" / "chinese-hubert-base")
BERT_PATH = str(GPT_SOVITS_ROOT / "GPT_SoVITS" / "pretrained_models" / "chinese-roberta-wwm-ext-large")
S2_CONFIG = str(GPT_SOVITS_ROOT / "GPT_SoVITS" / "configs" / "s2.json")
PRETRAINED_S2G_V4 = str(
    GPT_SOVITS_ROOT / "GPT_SoVITS" / "pretrained_models" / "gsv-v4-pretrained" / "s2Gv4.pth"
)
VOCODER_PATH = str(
    GPT_SOVITS_ROOT / "GPT_SoVITS" / "pretrained_models" / "gsv-v4-pretrained" / "vocoder.pth"
)

import nltk

for pkg in ("averaged_perceptron_tagger_eng", "cmudict", "averaged_perceptron_tagger"):
    try:
        nltk.data.find(f"taggers/{pkg}" if "tagger" in pkg else f"corpora/{pkg}")
    except LookupError:
        nltk.download(pkg, quiet=True)

print("[asuna-tts] Loading HuBERT...")
from GPT_SoVITS.feature_extractor import cnhubert  # noqa: E402

cnhubert.cnhubert_base_path = CNHUBERT_PATH
hubert = cnhubert.get_model().half().to(DEVICE).eval()

print("[asuna-tts] Loading BERT...")
from transformers import AutoModelForMaskedLM, AutoTokenizer  # noqa: E402

tokenizer = AutoTokenizer.from_pretrained(BERT_PATH)
bert = AutoModelForMaskedLM.from_pretrained(BERT_PATH).half().to(DEVICE).eval()

print("[asuna-tts] Loading SoVITS v4 (DiT + LoRA-merged)...")
import GPT_SoVITS.utils as utils  # noqa: E402
from GPT_SoVITS.module.models import Generator, SynthesizerTrnV3  # noqa: E402
from GPT_SoVITS.module.mel_processing import (  # noqa: E402
    mel_spectrogram_torch,
    spectrogram_torch,
)
from peft import LoraConfig, get_peft_model  # noqa: E402

hps = utils.get_hparams_from_file(S2_CONFIG)
hps.model.version = "v4"

vits = SynthesizerTrnV3(
    hps.data.filter_length // 2 + 1,
    hps.train.segment_size // hps.data.hop_length,
    n_speakers=hps.data.n_speakers,
    **hps.model,
)
base_state = torch.load(PRETRAINED_S2G_V4, map_location="cpu", weights_only=False)["weight"]
vits.load_state_dict(base_state, strict=False)

lora_config = LoraConfig(
    target_modules=["to_k", "to_q", "to_v", "to_out.0"],
    r=32,
    lora_alpha=32,
    init_lora_weights=True,
)
vits.cfm = get_peft_model(vits.cfm, lora_config)

sovits_dir = GPT_SOVITS_ROOT / "SoVITS_weights_v4"
sovits_files = sorted(
    sovits_dir.glob("asuna_combined*.pth"),
    key=lambda p: int(p.stem.split("_e")[1].split("_")[0]),
)
if not sovits_files:
    raise SystemExit(f"No Asuna SoVITS LoRA checkpoints found in {sovits_dir}")
SOVITS_PATH = str(sovits_files[-1])
print(f"[asuna-tts]   SoVITS ckpt: {Path(SOVITS_PATH).name}")
ft_state = torch.load(SOVITS_PATH, map_location="cpu", weights_only=False)["weight"]
vits.load_state_dict(ft_state, strict=False)
vits.cfm = vits.cfm.merge_and_unload()
vits = vits.half().to(DEVICE).eval()

print("[asuna-tts] Loading 48kHz vocoder...")
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
vocoder.load_state_dict(torch.load(VOCODER_PATH, map_location="cpu", weights_only=False))
vocoder = vocoder.half().to(DEVICE).eval()

print("[asuna-tts] Loading GPT (v3-base, fine-tuned)...")
from GPT_SoVITS.AR.models.t2s_lightning_module import (  # noqa: E402
    Text2SemanticLightningModule,
)

gpt_files = sorted(
    (GPT_SOVITS_ROOT / "GPT_weights_v3").glob("asuna_combined-e*.ckpt"),
    key=lambda p: int(p.stem.split("-e")[1]),
)
if not gpt_files:
    raise SystemExit("No Asuna GPT checkpoints found")
GPT_PATH = str(gpt_files[-1])
print(f"[asuna-tts]   GPT ckpt: {Path(GPT_PATH).name}")
s1config = {
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
gpt_model = Text2SemanticLightningModule(s1config, Path("."), is_train=False)
gpt_model.load_state_dict(
    torch.load(GPT_PATH, map_location="cpu", weights_only=False)["weight"], strict=False
)
gpt_model = gpt_model.half().to(DEVICE).eval()
gpt_model.model.infer_panel = gpt_model.model.infer_panel_naive

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

import librosa  # noqa: E402

from GPT_SoVITS.text import cleaned_text_to_sequence  # noqa: E402
from GPT_SoVITS.text.cleaner import clean_text  # noqa: E402
from tools.my_utils import load_audio  # noqa: E402

SPEC_MIN, SPEC_MAX = -12, 2


def _norm_spec(x):
    return (x - SPEC_MIN) / (SPEC_MAX - SPEC_MIN) * 2 - 1


def _denorm_spec(x):
    return (x + 1) / 2 * (SPEC_MAX - SPEC_MIN) + SPEC_MIN


def _mel_v4(x):
    return mel_spectrogram_torch(
        x,
        n_fft=1280,
        win_size=1280,
        hop_size=320,
        num_mels=100,
        sampling_rate=32000,
        fmin=0,
        fmax=None,
        center=False,
    )


def _phoneme_ids(text, lang):
    phones, w2p, norm = clean_text(text, lang, "v2")
    return cleaned_text_to_sequence(phones, "v2"), w2p, norm


def _bert_for(phone_ids, w2p, norm, lang):
    if lang != "zh":
        return torch.zeros((1024, len(phone_ids)), dtype=torch.float32)
    with torch.no_grad():
        inp = {k: v.to(DEVICE) for k, v in tokenizer(norm, return_tensors="pt").items()}
        out = bert(**inp, output_hidden_states=True)
        res = torch.cat(out["hidden_states"][-3:-2], -1)[0].cpu()[1:-1]
    feats = [res[i].repeat(w2p[i], 1) for i in range(len(w2p))]
    return torch.cat(feats, dim=0).T


def _ssl(wav_path):
    audio = load_audio(wav_path, 32000)
    audio16 = librosa.resample(audio, orig_sr=32000, target_sr=16000).astype(np.float32)
    t = torch.from_numpy(audio16).half().to(DEVICE)
    with torch.no_grad():
        return hubert.model(t.unsqueeze(0))["last_hidden_state"].transpose(1, 2)


def _ref_spec(wav_path):
    audio = load_audio(wav_path, hps.data.sampling_rate)
    return spectrogram_torch(
        torch.FloatTensor(audio).unsqueeze(0),
        hps.data.filter_length,
        hps.data.sampling_rate,
        hps.data.hop_length,
        hps.data.win_length,
        center=False,
    )


def _ref_mel(wav_path):
    audio = load_audio(wav_path, 32000)
    audio_t = torch.FloatTensor(audio).unsqueeze(0).to(DEVICE)
    return _norm_spec(_mel_v4(audio_t)).half()


# ---------------------------------------------------------------------------
# Reference cache.
# ---------------------------------------------------------------------------

REF_WAV = os.environ.get(
    "TTS_REFERENCE_AUDIO",
    str(GPT_SOVITS_ROOT / "logs" / "asuna_combined" / "0_sliced" / "0003.wav"),
)
REF_TEXT = os.environ.get("TTS_REFERENCE_TEXT", "ここは私に任せて私を選んでくれる")
REF_LANG = os.environ.get("TTS_REFERENCE_LANG", "ja")
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "asuna")
DEFAULT_LANGUAGE = os.environ.get("TTS_LANGUAGE", "ja")

print(f"[asuna-tts] Caching reference: {Path(REF_WAV).name} ({REF_LANG})")
ref_ssl = _ssl(REF_WAV)
with torch.no_grad():
    ref_codes = vits.extract_latent(ref_ssl)
ref_semantic = ref_codes[0, 0, :]
ref_phone_ids, ref_w2p, ref_norm = _phoneme_ids(REF_TEXT, REF_LANG)
ref_spec = _ref_spec(REF_WAV).half().to(DEVICE)
ref_mel = _ref_mel(REF_WAV)


# ---------------------------------------------------------------------------
# Inference. Returns 48 kHz float32 mono waveform.
# ---------------------------------------------------------------------------


def synthesize(text: str, lang: str, top_k: int = 15, temperature: float = 1.0,
               sample_steps: int = 32) -> np.ndarray:
    phone_ids, w2p, norm = _phoneme_ids(text, lang)
    bert_feat = _bert_for(phone_ids, w2p, norm, lang)
    all_phone_ids = torch.LongTensor(phone_ids).unsqueeze(0).to(DEVICE)
    all_phone_lens = torch.LongTensor([len(phone_ids)]).to(DEVICE)
    all_bert = bert_feat.half().unsqueeze(0).to(DEVICE)
    prompt_sem = ref_semantic[: min(50, ref_semantic.shape[0])].unsqueeze(0).to(DEVICE)

    with torch.no_grad():
        gen = gpt_model.model.infer_panel(
            all_phone_ids, all_phone_lens, prompt_sem, all_bert,
            top_k=top_k, top_p=1, temperature=temperature,
            early_stop_num=hps.data.sampling_rate // hps.data.hop_length * 54,
        )
        y, idx = next(gen)
    pred_sem = y[0, -idx:].unsqueeze(0).unsqueeze(0).to(DEVICE)

    prompt_sem_full = ref_semantic.unsqueeze(0).unsqueeze(0).to(DEVICE)
    ref_phones_t = torch.LongTensor(ref_phone_ids).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        fea_ref, ge = vits.decode_encp(prompt_sem_full, ref_phones_t, ref_spec)
        fea_todo, ge = vits.decode_encp(pred_sem, all_phone_ids, ref_spec, ge, 1.0)

        T_min = min(ref_mel.shape[2], fea_ref.shape[2])
        mel2 = ref_mel[:, :, :T_min]
        fea_ref = fea_ref[:, :, :T_min]
        T_ref = 500    # vocoder_configs["T_ref"] for v4
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
            cfm_res = vits.cfm.inference(
                fea, torch.LongTensor([fea.size(1)]).to(fea.device),
                mel2, sample_steps, inference_cfg_rate=0,
            )
            cfm_res = cfm_res[:, :, mel2.shape[2]:]
            mel2 = cfm_res[:, :, -T_min:]
            fea_ref = chunk[:, :, -T_min:]
            cfm_results.append(cfm_res)

        full_mel = torch.cat(cfm_results, 2)
        full_mel = _denorm_spec(full_mel)
        wav_gen = vocoder(full_mel)
        audio = wav_gen[0, 0].cpu().float().numpy()

    return audio  # 48 kHz mono float32


# ---------------------------------------------------------------------------
# HTTP server (ZeroClaw avatar TTS port contract).
# ---------------------------------------------------------------------------


class TtsRequest(BaseModel):
    text: str
    language: str = DEFAULT_LANGUAGE
    voice: str | None = None
    speed: float = 1.0


SAMPLE_RATE = 48000

app = FastAPI(title="asuna-tts (GPT-SoVITS v4)")


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


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "engine": "gpt-sovits-v4",
        "voices": [DEFAULT_VOICE],
        "languages": ["ja", "en", "zh"],
        "default_voice": DEFAULT_VOICE,
        "default_language": DEFAULT_LANGUAGE,
        "sample_rate": SAMPLE_RATE,
    }


@app.post("/tts")
async def tts(req: TtsRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(400, "text must not be empty")
    if req.language not in ("ja", "en", "zh"):
        raise HTTPException(400, f"unsupported language: {req.language}")

    t0 = time.time()
    try:
        audio = synthesize(req.text, req.language)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"synthesis failed: {e}") from e

    if abs(req.speed - 1.0) > 1e-3:
        audio = librosa.effects.time_stretch(audio, rate=req.speed)

    wav = _wav_bytes(audio, SAMPLE_RATE)
    duration = len(audio) / SAMPLE_RATE
    print(
        f"[asuna-tts] /tts lang={req.language} chars={len(req.text)} "
        f"audio={duration:.2f}s wall={time.time() - t0:.2f}s"
    )
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "X-Sample-Rate": str(SAMPLE_RATE),
            "X-Channels": "1",
            "X-Format": "wav",
        },
    )


if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", "9880"))
    print(f"[asuna-tts] serving on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
