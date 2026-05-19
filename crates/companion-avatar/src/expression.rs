//! Expression mapping: agent emotional state → Live2D expression parameters.
//!
//! Supports two detection modes:
//! - **Keyword**: scans agent response for emotion keywords, maps via config table.
//! - **LLM tag**: detects inline `[emotion:happy]` tags, strips them before TTS.

use std::collections::HashMap;

use crate::config::ExpressionMappingConfig;

/// A mapped Live2D expression to apply to the model.
#[derive(Debug, Clone)]
pub struct Live2DExpression {
    /// Expression name matching the Live2D model.
    pub name: String,
    /// Intensity 0.0–1.0.
    pub intensity: f32,
    /// Duration in ms to hold before returning to idle.
    pub duration_ms: Option<u32>,
}

impl Default for Live2DExpression {
    fn default() -> Self {
        Self {
            name: "neutral".to_string(),
            intensity: 0.8,
            duration_ms: Some(3000),
        }
    }
}

/// Maps agent emotional state to Live2D expression parameters.
pub struct ExpressionMapper {
    /// Emotion label → Live2D expression name.
    mapping: HashMap<String, String>,
    /// Default expression when no emotion detected.
    default_expression: String,
    /// Detection mode: "keyword" or "llm_tag".
    detection_mode: String,
    /// Keyword → emotion label.
    keyword_map: HashMap<String, String>,
}

impl ExpressionMapper {
    /// Build from config.
    pub fn new(config: &ExpressionMappingConfig) -> Self {
        Self {
            mapping: config.mapping.clone(),
            default_expression: config.default.clone(),
            detection_mode: config.detection_mode.clone(),
            keyword_map: config.keyword_map.clone(),
        }
    }

    /// Detect expression from agent response text.
    pub fn detect(&self, text: &str) -> Live2DExpression {
        match self.detection_mode.as_str() {
            "llm_tag" => self.detect_llm_tag(text),
            _ => self.detect_keyword(text),
        }
    }

    /// Strip emotion tags from text (for TTS input).
    pub fn strip_tags(&self, text: &str) -> String {
        let re = regex::Regex::new(r"\[emotion:\w+\]").unwrap();
        re.replace_all(text, "").trim().to_string()
    }

    fn detect_keyword(&self, text: &str) -> Live2DExpression {
        let lower = text.to_lowercase();
        for (keyword, emotion) in &self.keyword_map {
            if lower.contains(keyword)
                && let Some(expr_name) = self.mapping.get(emotion)
            {
                return Live2DExpression {
                    name: expr_name.clone(),
                    intensity: 0.8,
                    duration_ms: Some(3000),
                };
            }
        }
        Live2DExpression {
            name: self.default_expression.clone(),
            intensity: 0.5,
            duration_ms: None,
        }
    }

    fn detect_llm_tag(&self, text: &str) -> Live2DExpression {
        let re = regex::Regex::new(r"\[emotion:(\w+)\]").unwrap();
        if let Some(caps) = re.captures(text)
            && let Some(emotion) = caps.get(1)
        {
            let emotion = emotion.as_str();
            if let Some(expr_name) = self.mapping.get(emotion) {
                return Live2DExpression {
                    name: expr_name.clone(),
                    intensity: 0.8,
                    duration_ms: Some(3000),
                };
            }
            // Fallback: use emotion name directly as expression
            return Live2DExpression {
                name: emotion.to_string(),
                intensity: 0.8,
                duration_ms: Some(3000),
            };
        }
        Live2DExpression {
            name: self.default_expression.clone(),
            intensity: 0.5,
            duration_ms: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ExpressionMappingConfig;

    fn test_config() -> ExpressionMappingConfig {
        ExpressionMappingConfig {
            mapping: HashMap::from([
                ("happy".to_string(), "smile".to_string()),
                ("sad".to_string(), "depressed".to_string()),
                ("angry".to_string(), "angry".to_string()),
                ("surprised".to_string(), "surprised".to_string()),
            ]),
            default: "neutral".to_string(),
            detection_mode: "keyword".to_string(),
            keyword_map: HashMap::from([
                ("happy".to_string(), "happy".to_string()),
                ("glad".to_string(), "happy".to_string()),
                ("sad".to_string(), "sad".to_string()),
                ("sorry".to_string(), "sad".to_string()),
                ("angry".to_string(), "angry".to_string()),
                ("wow".to_string(), "surprised".to_string()),
            ]),
        }
    }

    #[test]
    fn keyword_detects_happy() {
        let mapper = ExpressionMapper::new(&test_config());
        let expr = mapper.detect("I'm so happy to see you!");
        assert_eq!(expr.name, "smile");
    }

    #[test]
    fn keyword_detects_sad() {
        let mapper = ExpressionMapper::new(&test_config());
        let expr = mapper.detect("I'm sorry to hear that.");
        assert_eq!(expr.name, "depressed");
    }

    #[test]
    fn keyword_returns_default_when_no_match() {
        let mapper = ExpressionMapper::new(&test_config());
        let expr = mapper.detect("The weather is cloudy today.");
        assert_eq!(expr.name, "neutral");
    }

    #[test]
    fn llm_tag_detects_emotion() {
        let mut config = test_config();
        config.detection_mode = "llm_tag".to_string();
        let mapper = ExpressionMapper::new(&config);
        let expr = mapper.detect("That's great! [emotion:happy]");
        assert_eq!(expr.name, "smile");
    }

    #[test]
    fn llm_tag_uses_emotion_name_as_fallback() {
        let mut config = test_config();
        config.detection_mode = "llm_tag".to_string();
        let mapper = ExpressionMapper::new(&config);
        let expr = mapper.detect("[emotion:excited]");
        assert_eq!(expr.name, "excited");
    }

    #[test]
    fn strip_tags_removes_emotion_markers() {
        let mapper = ExpressionMapper::new(&test_config());
        let cleaned = mapper.strip_tags("Hello [emotion:happy] world!");
        assert_eq!(cleaned, "Hello  world!");
    }

    #[test]
    fn strip_tags_no_tags_returns_original() {
        let mapper = ExpressionMapper::new(&test_config());
        let cleaned = mapper.strip_tags("Hello world!");
        assert_eq!(cleaned, "Hello world!");
    }

    #[test]
    fn strip_tags_handles_multiple_tags() {
        let mapper = ExpressionMapper::new(&test_config());
        let cleaned = mapper.strip_tags("[emotion:happy] Hi [emotion:sad] there");
        assert!(!cleaned.contains("[emotion:"));
        assert!(cleaned.contains("Hi"));
        assert!(cleaned.contains("there"));
    }

    #[test]
    fn keyword_is_case_insensitive() {
        let mapper = ExpressionMapper::new(&test_config());
        let expr = mapper.detect("WOW that's amazing");
        assert_eq!(expr.name, "surprised");
    }

    #[test]
    fn llm_tag_unmapped_emotion_uses_emotion_name_directly() {
        let mut config = test_config();
        config.detection_mode = "llm_tag".to_string();
        let mapper = ExpressionMapper::new(&config);
        let expr = mapper.detect("[emotion:joyful]");
        assert_eq!(expr.name, "joyful");
        assert!((expr.intensity - 0.8).abs() < f32::EPSILON);
    }

    #[test]
    fn keyword_default_when_text_only_has_neutral_words() {
        let mapper = ExpressionMapper::new(&test_config());
        let expr = mapper.detect("");
        assert_eq!(expr.name, "neutral");
    }

    // ── Additional edge-case coverage (extended test framework) ─────

    #[test]
    fn keyword_emoji_only_text_returns_default() {
        // Emoji-only input — no keyword match should ever fire.
        let mapper = ExpressionMapper::new(&test_config());
        let expr = mapper.detect("🌸🌟✨");
        assert_eq!(expr.name, "neutral");
    }

    #[test]
    fn keyword_mixed_language_japanese_english() {
        // Japanese + English: "happy" in the middle of a JP sentence
        // should still trip the keyword.
        let mapper = ExpressionMapper::new(&test_config());
        let expr = mapper.detect("今日はとてもhappyだよ");
        assert_eq!(expr.name, "smile");
    }

    #[test]
    fn keyword_very_long_input_doesnt_panic() {
        // 100 KB string with a happy keyword near the end.
        let mut s = "x".repeat(100_000);
        s.push_str(" happy ");
        let mapper = ExpressionMapper::new(&test_config());
        let expr = mapper.detect(&s);
        assert_eq!(expr.name, "smile");
    }

    #[test]
    fn strip_tags_handles_unicode_around_tag() {
        let mapper = ExpressionMapper::new(&test_config());
        let cleaned = mapper.strip_tags("日本語[emotion:happy]の文章");
        assert!(!cleaned.contains("[emotion:"));
        assert!(cleaned.contains("日本語"));
        assert!(cleaned.contains("の文章"));
    }

    #[test]
    fn strip_tags_emoji_only_input_unchanged() {
        // No tags → should return the input verbatim (modulo trim).
        let mapper = ExpressionMapper::new(&test_config());
        let cleaned = mapper.strip_tags("🌸🌟✨");
        assert_eq!(cleaned, "🌸🌟✨");
    }

    #[test]
    fn llm_tag_with_uppercase_emotion_falls_through_to_name() {
        // The mapping is lowercase; an uppercase emotion in a tag
        // should still go through the fallback path (use the literal
        // emotion name as the expression).
        let mut config = test_config();
        config.detection_mode = "llm_tag".to_string();
        let mapper = ExpressionMapper::new(&config);
        let expr = mapper.detect("[emotion:CALM]");
        // No "CALM" in mapping → emotion name used directly.
        assert_eq!(expr.name, "CALM");
    }

    #[test]
    fn llm_tag_no_tag_returns_default_in_llm_mode() {
        let mut config = test_config();
        config.detection_mode = "llm_tag".to_string();
        let mapper = ExpressionMapper::new(&config);
        let expr = mapper.detect("just plain text no tags");
        assert_eq!(expr.name, "neutral");
        // Default-mode intensity is 0.5 (see detect_llm_tag fallback).
        assert!((expr.intensity - 0.5).abs() < f32::EPSILON);
    }
}
