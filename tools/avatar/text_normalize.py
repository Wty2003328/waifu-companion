"""Text normalisation for the TTS pipeline.

The GPT-SoVITS AR model was trained on Japanese phoneme sequences from
clean spoken JA. When input text contains characters or patterns the
phonemizer (pyopenjtalk) doesn't have a natural mapping for, it emits
unusual phoneme runs that the AR has never seen during training. The
model then either loops (cuda-graph backend's response to OOD input)
or early-stops (naive backend's response).

**The root cause is upstream of the AR.** pyopenjtalk takes input
faithfully — if you give it `sunny`, it spells the letters out as
`e s u y u u e n u e n u w a i` (14 phonemes for what should be 3,
"サニー"). The AR has never seen a 14-phoneme run for a single English
word, so it gets stuck.

This module **rewrites the input text** so pyopenjtalk only ever sees
characters it knows how to phonemise naturally. Specifically:

  - English words → natural katakana via the `alkana` corpus
    (8k+ English words with their accepted Japanese loanword renditions),
    with a letter-by-letter katakana fallback for unknown words
  - Tilde/wave dash variants → drop or replace with long-sound mark
  - Ellipsis runs → single full-stop
  - Stray markdown decorations → space (defense-in-depth with ws.rs)
  - Non-spaced-out CamelCase splits → space-separated tokens (so
    "GitHub" becomes "Git Hub" → "Git" looked up, "Hub" looked up)

Applied INSIDE the engine, right before `_phoneme_ids` is called, so
every code path (single-shot, segmented, retried) benefits.

Public API:

    from text_normalize import normalize_for_tts
    safe = normalize_for_tts("少しsunnyな日になります", lang="ja")
    # -> "少しサニーな日になります"
"""

from __future__ import annotations

import re
import unicodedata
from typing import Optional


# Lazy import: alkana pulls in a CSV corpus on first call (~50 ms).
# Engine init is hot path; defer to first translate call.
_ALKANA = None
_G2P_EN = None


def _alkana_lookup(word: str) -> Optional[str]:
    """Lazy-init wrapper around `alkana.get_kana(word)`. Returns the
    katakana rendition or None for unknown words."""
    global _ALKANA
    if _ALKANA is None:
        try:
            import alkana
            _ALKANA = alkana.get_kana
        except ImportError:
            _ALKANA = lambda _w: None
    try:
        return _ALKANA(word.lower())
    except Exception:
        return None


# ── Systematic English → katakana via ARPAbet ────────────────────────
# When alkana doesn't know a word (brand names, neologisms, made-up
# strings), we still need an in-distribution katakana representation
# for the AR. The standard linguistic process:
#
#   word → ARPAbet phonemes (g2p_en, handles any English-shaped input)
#        → katakana morae (Japanese loanword phonotactic adaptation)
#
# This is exactly what produces "iPhone → アイフォン", "GitHub → ギットハブ"
# etc. natively — not a dictionary, the phonological rules.
#
# The CV-combination table below is the well-known Japanese loanword
# phonology adapter: every English consonant maps to a katakana row
# (using gairaigo column conventions: ティ for /ti/, ファ for /fa/,
# ヴァ for /va/, etc.), every vowel maps to a column, and lone
# consonants get an epenthetic ウ (or ッ for geminate-like).

# Every English vowel decomposes into (column, suffix):
#   - `column` picks the CV row's column for the preceding consonant
#     (e.g., S+a → サ, K+o → コ)
#   - `suffix` is the off-glide / length mark that follows (ウ for /aʊ/,
#     イ for /aɪ/, ー for long vowels, "" for monophthongs)
# Standalone (no preceding consonant) vowels are reconstructed from
# the same decomposition: column's a/i/u/e/o vowel + suffix.
_V_DECOMP: dict[str, tuple[str, str]] = {
    "AA": ("a", ""),
    "AE": ("a", ""),
    "AH": ("a", ""),
    "AO": ("o", ""),
    "AW": ("a", "ウ"),
    "AY": ("a", "イ"),
    "EH": ("e", ""),
    "ER": ("a", "ー"),
    "EY": ("e", "イ"),
    "IH": ("i", ""),
    "IY": ("i", "ー"),
    "OW": ("o", "ウ"),
    "OY": ("o", "イ"),
    "UH": ("u", ""),
    "UW": ("u", "ー"),
}

# Standalone vowel form per column (used when no preceding consonant).
_V_STANDALONE: dict[str, str] = {
    "a": "ア", "i": "イ", "u": "ウ", "e": "エ", "o": "オ",
}

# Consonant → row by vowel column.
# Layout: row_dict[col] gives the katakana mora. Empty rows fall back
# to the consonant's default standalone form (defined below).
_CONS_CV: dict[str, dict[str, str]] = {
    "B":  {"a": "バ", "i": "ビ", "u": "ブ", "e": "ベ", "o": "ボ"},
    "CH": {"a": "チャ", "i": "チ", "u": "チュ", "e": "チェ", "o": "チョ"},
    "D":  {"a": "ダ", "i": "ディ", "u": "ドゥ", "e": "デ", "o": "ド"},
    "DH": {"a": "ザ", "i": "ジ", "u": "ズ", "e": "ゼ", "o": "ゾ"},
    "F":  {"a": "ファ", "i": "フィ", "u": "フ", "e": "フェ", "o": "フォ"},
    "G":  {"a": "ガ", "i": "ギ", "u": "グ", "e": "ゲ", "o": "ゴ"},
    "HH": {"a": "ハ", "i": "ヒ", "u": "フ", "e": "ヘ", "o": "ホ"},
    "JH": {"a": "ジャ", "i": "ジ", "u": "ジュ", "e": "ジェ", "o": "ジョ"},
    "K":  {"a": "カ", "i": "キ", "u": "ク", "e": "ケ", "o": "コ"},
    "L":  {"a": "ラ", "i": "リ", "u": "ル", "e": "レ", "o": "ロ"},
    "M":  {"a": "マ", "i": "ミ", "u": "ム", "e": "メ", "o": "モ"},
    "N":  {"a": "ナ", "i": "ニ", "u": "ヌ", "e": "ネ", "o": "ノ"},
    "P":  {"a": "パ", "i": "ピ", "u": "プ", "e": "ペ", "o": "ポ"},
    "R":  {"a": "ラ", "i": "リ", "u": "ル", "e": "レ", "o": "ロ"},
    "S":  {"a": "サ", "i": "シ", "u": "ス", "e": "セ", "o": "ソ"},
    "SH": {"a": "シャ", "i": "シ", "u": "シュ", "e": "シェ", "o": "ショ"},
    "T":  {"a": "タ", "i": "ティ", "u": "トゥ", "e": "テ", "o": "ト"},
    "TH": {"a": "サ", "i": "シ", "u": "ス", "e": "セ", "o": "ソ"},
    "V":  {"a": "ヴァ", "i": "ヴィ", "u": "ヴ", "e": "ヴェ", "o": "ヴォ"},
    "W":  {"a": "ワ", "i": "ウィ", "u": "ウ", "e": "ウェ", "o": "ウォ"},
    "Y":  {"a": "ヤ", "i": "イ", "u": "ユ", "e": "イェ", "o": "ヨ"},
    "Z":  {"a": "ザ", "i": "ジ", "u": "ズ", "e": "ゼ", "o": "ゾ"},
    "ZH": {"a": "ジャ", "i": "ジ", "u": "ジュ", "e": "ジェ", "o": "ジョ"},
    # NG handled separately (digraph; usually attaches to prev vowel).
}

# Lone consonant (cluster or word-final, no following vowel) → katakana
# with epenthetic ウ in most cases. Established loanword conventions:
# T/D get ト/ド (not トゥ/ドゥ), CH/J keep their default mora form.
_CONS_LONE: dict[str, str] = {
    "B": "ブ", "CH": "チ", "D": "ド", "DH": "ズ",
    "F": "フ", "G": "グ", "HH": "フ", "JH": "ジ",
    "K": "ク", "L": "ル", "M": "ム", "N": "ン",
    "P": "プ", "R": "ル", "S": "ス", "SH": "シュ",
    "T": "ト", "TH": "ス", "V": "ヴ", "W": "ウ",
    "Y": "イ", "Z": "ズ", "ZH": "ジュ",
}


def _g2p_en() -> Optional[object]:
    """Lazy-init g2p_en. Returns the G2p instance or None if missing."""
    global _G2P_EN
    if _G2P_EN is None:
        try:
            from g2p_en import G2p
            _G2P_EN = G2p()
        except ImportError:
            _G2P_EN = False  # marker for "tried and failed"
    return _G2P_EN if _G2P_EN else None


_STRESS_RE = re.compile(r"\d+$")


def _vowel_standalone(v: str) -> str:
    """Standalone (unattached) ARPAbet vowel → katakana, reconstructed
    from `_V_DECOMP`. AA/AE/AH all → "ア" (no suffix); OW → "オウ", etc."""
    col, suf = _V_DECOMP[v]
    return _V_STANDALONE[col] + suf


def _arpabet_to_katakana(phonemes: list[str]) -> str:
    """Walk an ARPAbet phoneme sequence and emit katakana morae.

    Core algorithm:
      1. Strip stress markers.
      2. Walk pairs (cur, nxt):
         a. If cur is the NG digraph: emit ン (assimilated) or ング
            (word-final) depending on what follows.
         b. If cur is consonant + nxt is vowel: pick the CV mora using
            the vowel's COLUMN, then append the vowel's SUFFIX (off-glide
            or length mark). Example: K + AY decomposes AY → (a-column,
            suffix "イ"); K's a-row is "カ"; result: "カイ".
         c. If cur is vowel alone: emit its standalone form.
         d. Otherwise: lone consonant with epenthetic ウ (or natural
            final form: ト for T, ド for D, ン for N).

    This is the standard Japanese loanword phonological adapter — what
    JA natives do unconsciously when spelling an English word in
    katakana. Produces in-distribution sequences for any g2p_en output.
    """
    phs = [_STRESS_RE.sub("", p) for p in phonemes]
    out: list[str] = []
    i = 0
    while i < len(phs):
        cur = phs[i]
        nxt = phs[i + 1] if i + 1 < len(phs) else None

        if cur == "NG":
            # Word-final NG = ング. NG-before-vowel = ン+next CV.
            out.append("ン" if nxt in _V_DECOMP else "ング")
            i += 1
            continue

        if cur in _V_DECOMP:
            out.append(_vowel_standalone(cur))
            i += 1
            continue

        if cur in _CONS_CV and nxt in _V_DECOMP:
            col, suffix = _V_DECOMP[nxt]
            row = _CONS_CV[cur]
            mora = row.get(col) or row.get("u") or _CONS_LONE.get(cur, "")
            out.append(mora + suffix)
            i += 2
            continue

        if cur in _CONS_LONE:
            out.append(_CONS_LONE[cur])
        # Unknown token: skip (don't emit ARPAbet codes into JA text)
        i += 1
    return "".join(out)


def _arpabet_for(word: str) -> Optional[list[str]]:
    """g2p_en wrapper. Returns the phoneme list or None on failure."""
    g = _g2p_en()
    if g is None:
        return None
    try:
        seq = g(word)
        # g2p_en returns a flat list including punctuation/space tokens
        # for multi-word input. Filter to alphabetic phoneme tokens
        # (those that start with a letter — punctuation tokens are
        # just the original char).
        return [p for p in seq if p and p[0].isalpha()]
    except Exception:
        return None


# Letter-by-letter katakana for fallback. Maps individual ASCII letters
# to their natural Japanese reading.
_LETTER_KATAKANA: dict[str, str] = {
    "a": "エー", "b": "ビー", "c": "シー", "d": "ディー", "e": "イー",
    "f": "エフ", "g": "ジー", "h": "エイチ", "i": "アイ", "j": "ジェイ",
    "k": "ケー", "l": "エル", "m": "エム", "n": "エヌ", "o": "オー",
    "p": "ピー", "q": "キュー", "r": "アール", "s": "エス", "t": "ティー",
    "u": "ユー", "v": "ブイ", "w": "ダブリュー", "x": "エックス",
    "y": "ワイ", "z": "ゼット",
}


def _letter_spell(word: str) -> str:
    """Fall-back rendering for English words `alkana` doesn't know.
    Spells the word letter by letter in katakana. For a 3-letter
    acronym like "API" → "エーピーアイ" (~6 phonemes), well within
    the AR's training distribution."""
    return "".join(_LETTER_KATAKANA.get(c.lower(), c) for c in word)


# ASCII letter run: `[A-Za-z]+`. Captures contiguous Latin letters so we
# can hand them to alkana / fallback as a single word. Excludes digits
# (pyopenjtalk handles them natively) and apostrophes (would split
# "don't" — rare in this domain, accept the slight quality loss).
_ENGLISH_WORD_RE = re.compile(r"[A-Za-z]+")


def _normalize_loanwords_ja(text: str) -> str:
    """Replace each contiguous run of ASCII letters with its natural
    katakana rendition. Resolution order per word:

      1. **alkana** (8k+ word corpus with editor-curated mappings) —
         produces native-feeling renditions for common loanwords.
      2. **g2p_en + ARPAbet→katakana** — produces a phonologically
         correct mapping for ANY English-shaped string (brand names,
         neologisms, made-up words). Same process Japanese natively
         uses for loanword adaptation.
      3. **Letter-by-letter spell** — last-resort fallback for single
         letters / words g2p_en chokes on. Always bounded.

    This is the systematic chain: no hand-maintained dictionary, every
    English-like input produces an in-distribution katakana sequence
    the AR has seen during JA training."""

    def _sub(m: re.Match) -> str:
        word = m.group(0)

        # Single letters → letter-spell (g2p_en returns the letter name)
        if len(word) == 1:
            return _letter_spell(word)

        # 1. alkana — well-known loanword corpus
        kana = _alkana_lookup(word)
        if kana:
            return kana

        # 2. g2p_en → ARPAbet → katakana. Works for any word the
        # English phonemizer can handle (including brand names and
        # made-up strings — the phonemizer rules out only non-Latin
        # gibberish, and `_arpabet_to_katakana` skips unknown tokens).
        arpa = _arpabet_for(word)
        if arpa:
            mapped = _arpabet_to_katakana(arpa)
            if mapped:
                return mapped

        # 3. Last resort: letter spell
        return _letter_spell(word)

    return _ENGLISH_WORD_RE.sub(_sub, text)


# ── Special-char normalisation ─────────────────────────────────────
# Map characters pyopenjtalk handles poorly to their Japanese
# equivalents (or drop entirely).
_CHAR_REMAP: dict[str, str] = {
    # Tilde variants: pyopenjtalk treats them inconsistently. The
    # full-width "～" gets converted to "チルダ" in some configs which
    # the AR has never seen. Map to a long-sound mark so it just
    # extends the preceding vowel.
    "〜": "ー",  # WAVE DASH  〜
    "∼": "ー",  # TILDE OPERATOR  ∼
    "～": "ー",  # FULLWIDTH TILDE ～
    "~": "ー",       # ASCII tilde
    # Ellipsis: pyopenjtalk often emits stop-tokens; the AR
    # over-pauses. Collapse to a single full-stop.
    "…": "。",  # HORIZONTAL ELLIPSIS …
    "⋯": "。",  # MIDLINE HORIZONTAL ELLIPSIS ⋯
    # Numbered-list bullets — rare in TTS text but possible from LLM
    # output; drop so they don't get read aloud.
    "•": "",
    "·": "",
    "‣": "",
    # Quote variants: smart quotes confuse pyopenjtalk's prosody
    # detection. Normalise to plain "".
    "“": '"', "”": '"',  # curly double quotes
    "‘": "'", "’": "'",  # curly single quotes
    # Dashes: pyopenjtalk handles ASCII "-" fine but unicode dashes
    # get spoken as "ハイフン". Replace with ASCII.
    "–": "-",  # en dash –
    "—": "-",  # em dash —
    "−": "-",  # minus sign −
}


def _apply_char_remap(text: str) -> str:
    """Translate problem characters to their pyopenjtalk-safe equivalents."""
    return text.translate({ord(k): v for k, v in _CHAR_REMAP.items()})


def _collapse_runs(text: str) -> str:
    """Collapse runs of "。" or ASCII "." down to a single one — fixes
    cases like '....' which the AR sometimes treats as multiple
    sentence ends and produces awkward pauses."""
    text = re.sub(r"。{2,}", "。", text)
    text = re.sub(r"\.{2,}", "。", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _nfkc(text: str) -> str:
    """Compatibility decomposition: collapses full-width ASCII digits
    (`１２`) to half-width (`12`) so pyopenjtalk's number-reader fires,
    and unifies look-alikes."""
    return unicodedata.normalize("NFKC", text)


# ── Multi-language Latin-word handlers ────────────────────────────
#
# Every non-Latin-script language hits the same failure mode when the
# user types English (or any Latin) inside it: the language's phonemizer
# either spells the Latin letters out individually (long phoneme runs →
# AR loops) or just emits the raw codepoints (the AR has never seen them
# → loops or early-stops). Each handler below rewrites Latin words
# *into native script* so the phonemizer never sees foreign characters.
#
# JA: alkana corpus → natural katakana (see `_normalize_loanwords_ja`).
# ZH / YUE: spell each letter out using Chinese-character mnemonics.
# KO: spell each letter out using Hangul mnemonics.
# EN: nothing — `g2p_en` handles English itself. But mixed-script
#     (Japanese embedded in English text) still needs handling; the
#     `clean_text` path strips unknown codepoints, which is acceptable
#     when the speaker is meant to be English-only.


# Latin letter → Chinese-character spelling. The AR has seen these
# characters extensively in regular Chinese training data, so it knows
# their pronunciation. "API" → "诶皮艾" (3 chars, ~6 phonemes), well
# in distribution.
_LETTER_HANZI: dict[str, str] = {
    "a": "诶", "b": "比", "c": "西", "d": "迪", "e": "伊",
    "f": "艾弗", "g": "吉", "h": "艾尺", "i": "艾", "j": "杰",
    "k": "凯", "l": "艾勒", "m": "艾姆", "n": "恩", "o": "欧",
    "p": "皮", "q": "丘", "r": "艾儿", "s": "艾斯", "t": "提",
    "u": "尤", "v": "维", "w": "豆贝尔由", "x": "艾克斯",
    "y": "歪", "z": "贼",
}


def _letter_spell_hanzi(word: str) -> str:
    return "".join(_LETTER_HANZI.get(c.lower(), c) for c in word)


def _normalize_loanwords_zh(text: str) -> str:
    """Replace ASCII letter runs with hanzi spellings so g2pw doesn't
    have to phonemize raw Latin letters."""
    return _ENGLISH_WORD_RE.sub(
        lambda m: _letter_spell_hanzi(m.group(0)), text,
    )


# Latin letter → Hangul spelling. Korean naturally uses Hangul to
# spell out English letters in mixed-script text. "API" → "에이피아이"
# (~6 phonemes), in distribution for g2pk.
_LETTER_HANGUL: dict[str, str] = {
    "a": "에이", "b": "비", "c": "씨", "d": "디", "e": "이",
    "f": "에프", "g": "지", "h": "에이치", "i": "아이", "j": "제이",
    "k": "케이", "l": "엘", "m": "엠", "n": "엔", "o": "오",
    "p": "피", "q": "큐", "r": "알", "s": "에스", "t": "티",
    "u": "유", "v": "브이", "w": "더블유", "x": "엑스",
    "y": "와이", "z": "지",
}


def _letter_spell_hangul(word: str) -> str:
    return "".join(_LETTER_HANGUL.get(c.lower(), c) for c in word)


def _normalize_loanwords_ko(text: str) -> str:
    """Replace ASCII letter runs with hangul spellings."""
    return _ENGLISH_WORD_RE.sub(
        lambda m: _letter_spell_hangul(m.group(0)), text,
    )


def normalize_for_tts(text: str, lang: str = "ja") -> str:
    """Apply every normalisation step in order. Idempotent: calling
    twice on already-normalised text is a no-op.

    `lang` selects the language-specific Latin-word handler. Supported:
    `ja` (alkana → katakana), `zh` / `yue` (hanzi letter spell),
    `ko` (hangul letter spell), `en` (no Latin handling; relies on
    g2p_en for English). Unknown lang falls through to char-remap only."""
    if not text:
        return text
    text = _nfkc(text)
    text = _apply_char_remap(text)
    if lang == "ja":
        text = _normalize_loanwords_ja(text)
    elif lang in ("zh", "yue"):
        text = _normalize_loanwords_zh(text)
    elif lang == "ko":
        text = _normalize_loanwords_ko(text)
    # en: no Latin-word handler; g2p_en handles English natively
    text = _collapse_runs(text)
    return text


# ── self-test ───────────────────────────────────────────────────────
if __name__ == "__main__":
    cases: list[tuple[str, str, str | None]] = [
        # ja
        ("ja", "こんにちは", "こんにちは"),
        ("ja", "少しsunnyな日になります", "少しサニーな日になります"),
        ("ja", "今日は～元気？", None),
        ("ja", "ABCを覚えよう", None),
        ("ja", "これは...", "これは。"),
        # zh — Latin → hanzi spell
        ("zh", "你好世界", "你好世界"),
        ("zh", "我用API开发", None),           # API → 诶皮艾
        ("zh", "GitHub是个好网站", None),      # GitHub → letter spell
        # ko — Latin → hangul spell
        ("ko", "안녕하세요", "안녕하세요"),
        ("ko", "API를 사용합니다", None),
        # yue — same handler as zh
        ("yue", "你好", "你好"),
        ("yue", "APIをつかう", None),
        # en — no Latin-word handler
        ("en", "Hello world", "Hello world"),
        ("en", "Use the API.", "Use the API."),
    ]
    for lang, inp, expected in cases:
        got = normalize_for_tts(inp, lang=lang)
        marker = "" if expected is None else ("✓" if got == expected else "✗")
        print(f"  [{lang}] {marker} {inp!r}  →  {got!r}"
              + (f"   (expected {expected!r})" if expected and got != expected else ""))
