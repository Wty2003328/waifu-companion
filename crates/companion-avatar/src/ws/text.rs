//! Pure text-processing helpers for the avatar WebSocket layer.
//!
//! Everything in here is `pub(super)` — visible to the rest of the `ws`
//! module but not exposed outside the crate. These functions handle the
//! grimy text normalization the agent's raw reply needs before it can
//! be handed to the TTS engine or the subtitle renderer:
//!
//! - [`safe_prefix`] — char-boundary-safe slice for logging.
//! - [`strip_emoji_and_markdown_for_tts`] — drop emoji and markdown
//!   decorators that TTS would read aloud as gibberish.
//! - [`strip_thinking_preamble`] — drop the leading reasoning-trace
//!   sentences some upstream agents leak into their replies.
//! - [`is_cjk`] — codepoint predicate used by the strip + detect helpers.
//! - [`detect_source_lang`] — best-effort source-language detection
//!   from reply text, for NMT `src_lang` selection.

/// Char-boundary-safe slice for diagnostic logging. Prevents panics when
/// the byte-position cap lands inside a multi-byte UTF-8 codepoint
/// (emoji and CJK in agent replies trip this constantly).
pub(super) fn safe_prefix(s: &str, max_bytes: usize) -> &str {
    let mut end = s.len().min(max_bytes);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Strip emoji + markdown decorations from a TTS-bound string.
///
/// Even with a strong "remove emoji" instruction in the subagent
/// system prompt, glm-4.5-flash (and similar small models) frequently
/// preserves them or replaces them with full-width "？？" — both of
/// which the TTS reads aloud as gibberish. This is the deterministic
/// safety net: post-process the model's output before handing it to
/// the TTS engine.
///
/// What we drop:
///   - Emoji (the entire pictograph block at U+1F300+, plus the
///     compatibility set in the BMP at U+2600–27BF, U+2700–27BF, etc.),
///     ZWJ glue, variation selectors, regional indicators.
///   - Markdown decorations: `*` `_` `~` `\`` `#` `>` when used as
///     surrounding punctuation. We deliberately keep them when
///     embedded inside a word (rare in TTS text).
///   - Run of full-width punctuation `？！。、` are preserved (they
///     belong in CJK speech).
pub(super) fn strip_emoji_and_markdown_for_tts(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        let cp = c as u32;
        let is_emoji = matches!(cp,
            0x1F300..=0x1FAFF      // pictographs, supplemental, etc.
            | 0x1F1E6..=0x1F1FF    // regional indicators (flags)
            | 0x2600..=0x27BF      // misc symbols + dingbats
            | 0xFE0F | 0xFE0E      // variation selectors (text/emoji)
            | 0x200D                // zero-width joiner
            | 0x20E3                // combining enclosing keycap
        );
        if is_emoji {
            continue;
        }
        // Common markdown decorators when on their own (not embedded
        // in CJK / words). Replace with a space so adjacent words
        // don't fuse, then collapse runs below.
        if matches!(c, '*' | '_' | '~' | '`' | '#' | '>' | '|' | '\\') {
            out.push(' ');
            continue;
        }
        out.push(c);
    }
    // Collapse runs of whitespace introduced by stripping.
    let collapsed: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.trim().to_string()
}

/// Strip leading thinking-trace preamble that some upstream agents
/// (zeroclaw with reasoning models, glm-4.5 without `thinking: disabled`,
/// etc.) leak into their reply text.
///
/// Two stripping passes run in tandem per leading sentence; we drop the
/// sentence if EITHER fires, then re-evaluate the next sentence:
///
/// 1. **Marker prefix match.** Drop sentences that begin with known
///    thinking-trace markers ("Let me check", "The user is", "Based on
///    USER.md", "I'll check the weather", "webhook_msg_…", etc.).
///    Case-insensitive on the leading ASCII portion.
///
/// 2. **Mostly-Latin sentence drop (when `prefer_cjk = true`).** Drop
///    leading sentences whose CJK content ratio is below 20%. Catches
///    the pattern `"明天" (tomorrow) likely means May 14...` where the
///    sentence STARTS with a CJK character in quotes but is structurally
///    English commentary. The previous "leading-Latin-char-count" gate
///    missed this because the first char was the `"` (Latin) followed
///    by CJK — only one leading Latin char.
///
/// The 20% threshold is the sweet spot: a real CJK reply with a few
/// English loanwords ("sunny", "14°C") sits well above 50%; a thinking
/// sentence with one quoted CJK term sits below 10%.
pub(super) fn strip_thinking_preamble(text: &str, prefer_cjk: bool) -> String {
    const MARKERS: &[&str] = &[
        "the user said",
        "the user is asking",
        "the user is",
        "the user wants",
        "the user mentioned",
        "the user needs",
        "let me check",
        "let me get",
        "let me store",
        "let me respond",
        "let me look",
        "let me ", // catch-all "let me X"
        "looking at the context",
        "looking at ",
        "based on the context",
        "based on user.md",
        "based on the user",
        "based on ",
        "first, let me",
        "first let me",
        "i should ",
        "i need to ",
        "i'll check",
        "i'll look",
        "webhook_msg_",
    ];

    /// Boundary chars used by both the lookahead (sentence we're judging)
    /// and the advance (where we cut to drop it). Includes CJK terminators
    /// so a thinking sentence ending with 。 still gets a clean cut.
    fn sentence_end_byte(s: &str) -> Option<usize> {
        s.char_indices()
            .find(|(_, c)| matches!(*c, '.' | '!' | '?' | '\n' | '。' | '！' | '？'))
            .map(|(i, c)| i + c.len_utf8())
    }

    /// True when the (already-isolated) sentence is well above the noise
    /// floor in length AND its CJK ratio is below 20%. Short sentences
    /// (`OK!`, `Yes.`, `はい。`) are too short to judge reliably — we
    /// preserve them.
    fn is_mostly_latin(sentence: &str) -> bool {
        let total = sentence.chars().count();
        if total < 12 {
            return false;
        }
        let cjk = sentence.chars().filter(|c| is_cjk(*c)).count();
        (cjk as f64) / (total as f64) < 0.20
    }

    let mut current: &str = text.trim_start();
    loop {
        // Lookahead: the leading sentence.
        let first_sentence_end = sentence_end_byte(current);
        let first_sentence = match first_sentence_end {
            Some(idx) => &current[..idx],
            None => current,
        };

        // Marker check on the leading ASCII portion (CJK passes through
        // `to_ascii_lowercase` unchanged, which is what we want).
        let probe: String = first_sentence.chars().take(60).collect();
        let probe_lc = probe.to_ascii_lowercase();
        let marker_match = MARKERS.iter().any(|m| probe_lc.starts_with(m));

        // CJK-aware drop. Only fires when the user is targeting a CJK
        // TTS language; otherwise it'd happily eat legitimate English
        // chat replies.
        let latin_drop = prefer_cjk && is_mostly_latin(first_sentence);

        if !marker_match && !latin_drop {
            break;
        }

        // Drop this sentence. If it has no terminator (a runaway one-
        // sentence "reply" that's just thinking), drop the whole text.
        match first_sentence_end {
            Some(idx) if idx < current.len() => {
                current = current[idx..].trim_start();
            }
            _ => {
                current = "";
                break;
            }
        }
    }

    current.to_string()
}

pub(super) fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x309F        // hiragana
        | 0x30A0..=0x30FF      // katakana
        | 0x3400..=0x4DBF      // CJK ext A
        | 0x4E00..=0x9FFF      // CJK unified
        | 0xF900..=0xFAFF      // CJK compat
        | 0x20000..=0x2FFFF    // CJK ext B-F
    )
}

/// Best-effort source-language detection from reply text. The companion's
/// `chat_language` setting is what the USER types in, but the agent
/// frequently replies in a different language than the user's input —
/// the user types Chinese, the agent replies Chinese; the user has
/// chat_language set to "en" because they originally configured it for
/// English chat. Without auto-detect, we'd hand NLLB the wrong
/// `src_lang` and get tokenizer garbage.
///
/// Heuristic over codepoint distribution:
///   - kana ratio ≥ 8%   → "ja" (kana is JA-exclusive; even small amounts disambiguate)
///   - han  ratio ≥ 30%  → "zh" (no kana → not JA → Chinese)
///   - cyrillic ratio ≥ 50% → "ru"
///   - hangul ratio ≥ 30%  → "ko"
///   - arabic ratio ≥ 50%  → "ar"
///   - otherwise None → caller falls back to the configured chat_language.
///
/// We deliberately don't try to distinguish further (Spanish vs French
/// vs Italian etc.) — NLLB on `en` source is OK for most Latin-script
/// languages; the failure mode we're fixing is the dramatic one
/// (Latin src on CJK input).
pub(super) fn detect_source_lang(text: &str) -> Option<&'static str> {
    let total: usize = text.chars().filter(|c| !c.is_whitespace()).count();
    if total < 4 {
        return None; // too short to judge
    }
    let mut kana = 0usize;
    let mut han = 0usize;
    let mut cyrillic = 0usize;
    let mut hangul = 0usize;
    let mut arabic = 0usize;
    for c in text.chars() {
        let cp = c as u32;
        if (0x3040..=0x309F).contains(&cp) || (0x30A0..=0x30FF).contains(&cp) {
            kana += 1;
        } else if (0x4E00..=0x9FFF).contains(&cp) || (0x3400..=0x4DBF).contains(&cp) {
            han += 1;
        } else if (0x0400..=0x04FF).contains(&cp) {
            cyrillic += 1;
        } else if (0xAC00..=0xD7AF).contains(&cp) {
            hangul += 1;
        } else if (0x0600..=0x06FF).contains(&cp) {
            arabic += 1;
        }
    }
    let t = total as f64;
    if (kana as f64) / t >= 0.08 {
        return Some("ja");
    }
    if (han as f64) / t >= 0.30 {
        return Some("zh");
    }
    if (hangul as f64) / t >= 0.30 {
        return Some("ko");
    }
    if (cyrillic as f64) / t >= 0.50 {
        return Some("ru");
    }
    if (arabic as f64) / t >= 0.50 {
        return Some("ar");
    }
    None
}

#[cfg(test)]
mod strip_thinking_tests {
    use super::strip_thinking_preamble;

    #[test]
    fn user_reported_leak_en_thinking_then_zh_reply() {
        // The exact text shape the user saw: English thinking trace
        // followed by a CJK reply. cross-lang flag on (tts=ja/zh).
        let raw = "The user is asking about today's weather and saying they \
                   feel a bit cold. Let me check the weather for their location. \
                   Based on USER.md, they're in America/Chicago timezone. \
                   Let me get the weather.才51度，难怪你觉得冷。都快三更半夜了。";
        let out = strip_thinking_preamble(raw, true);
        assert!(
            out.starts_with("才51度"),
            "expected leading CJK after strip, got: {out:?}"
        );
        assert!(
            !out.to_lowercase().contains("let me"),
            "thinking markers should be gone, got: {out:?}"
        );
    }

    #[test]
    fn cjk_quoted_in_thinking_then_zh_reply() {
        // 2026-05-14 user-reported leak: thinking sentence STARTS with
        // a CJK term in quotes (`"明天" (tomorrow) likely means...`).
        // The previous heuristic missed this because the first char
        // was CJK and the "leading-latin-char-count" gate never fired.
        // New sentence-level mostly-Latin drop must catch it.
        let raw = "\"明天\" (tomorrow) likely means May 14 during the day \
                   (since it's technically already May 14 but nighttime) or May 15. \
                   I'll check the weather with a 2-day forecast to cover both.\
                   明天也就是5月14号，白天挺舒服的～ sunny，最高14°C，不下雨。\
                   后天（15号）就别想晒太阳了，一整天都在下雨";
        let out = strip_thinking_preamble(raw, true);
        assert!(
            out.starts_with("明天也就是5月14号"),
            "expected clean Chinese reply, got: {out:?}"
        );
        assert!(
            !out.contains("likely means"),
            "English commentary should be gone, got: {out:?}"
        );
        assert!(
            !out.contains("I'll check"),
            "intent statement should be gone, got: {out:?}"
        );
    }

    #[test]
    fn cjk_reply_with_loanwords_preserved() {
        // The user's real reply contained " sunny" and "14°C" — Latin
        // chunks inside a Chinese sentence. The 20% threshold must
        // tolerate these (sentence is still majority CJK).
        let raw = "明天也就是5月14号，白天挺舒服的～ sunny，最高14°C，不下雨。";
        let out = strip_thinking_preamble(raw, true);
        assert_eq!(out, raw, "loanwords should not trigger the Latin drop");
    }

    #[test]
    fn zh_chat_doesnt_break_strip_when_tts_is_ja() {
        // When the user chats in Chinese and TTS is Japanese, the agent
        // can still leak English thinking. prefer_cjk only checks tts,
        // not chat — so the strip must still fire.
        let raw = "Let me think about this. 今日も元気ですか？";
        let out = strip_thinking_preamble(raw, true);
        assert_eq!(out, "今日も元気ですか？");
    }

    #[test]
    fn pure_en_thinking_then_en_reply() {
        // No CJK to fall through to — must catch via marker matching.
        let raw = "Let me check the weather. It is 51 degrees outside.";
        let out = strip_thinking_preamble(raw, false);
        assert_eq!(out, "It is 51 degrees outside.");
    }

    #[test]
    fn no_preamble_passes_through_unchanged() {
        let raw = "Hello there! How are you today?";
        let out = strip_thinking_preamble(raw, false);
        assert_eq!(out, raw);
    }

    #[test]
    fn cjk_only_input_passes_through() {
        let raw = "こんにちは、元気ですか？今日もいい天気ですね。";
        let out = strip_thinking_preamble(raw, true);
        assert_eq!(out, raw);
    }

    #[test]
    fn empty_input_yields_empty() {
        assert_eq!(strip_thinking_preamble("", false), "");
        assert_eq!(strip_thinking_preamble("   \n  ", false), "");
    }

    #[test]
    fn multiple_thinking_sentences_all_stripped() {
        let raw = "Let me check. Looking at the context, this is what I see. \
                   Based on the user's request, I need to respond. \
                   The actual reply starts here.";
        let out = strip_thinking_preamble(raw, false);
        assert_eq!(out, "The actual reply starts here.");
    }

    #[test]
    fn short_latin_prefix_preserved_when_prefer_cjk() {
        // "OK!" + JA reply — the Latin prefix is too short (3 chars) to
        // trigger the CJK fallback heuristic (threshold 16). Should pass
        // through.
        let raw = "OK! 分かりました。";
        let out = strip_thinking_preamble(raw, true);
        assert_eq!(out, raw.trim_start());
    }

    #[test]
    fn webhook_msg_marker_stripped() {
        let raw = "webhook_msg_abc123 was sent. The real reply text.";
        let out = strip_thinking_preamble(raw, false);
        assert_eq!(out, "The real reply text.");
    }

    #[test]
    fn does_not_split_inside_multibyte_codepoint() {
        // Regression guard for byte-vs-char-boundary slicing. A CJK
        // terminator (3-byte 。) at the boundary must not panic.
        let raw = "Let me try。実際の返答です。";
        let out = strip_thinking_preamble(raw, false);
        // The English "Let me try" has no ASCII terminator, so the whole
        // thing is dropped (treated as one runaway thinking sentence).
        // Acceptable degradation: we never panic.
        let _ = out;
    }
}
