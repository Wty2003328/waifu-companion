//! WebSocket protocol types for Live2D avatar communication.
//!
//! Route: `GET /ws/avatar`
//!
//! ## Server → Client (`AvatarNotification`)
//!
//! 1. On connect: `Connected` + `ModelInfo`
//! 2. During agent turn: `Expression` → `Audio` (with lip sync) → `Idle`
//!
//! ## Client → Server (`AvatarMessage`)
//!
//! - `Ready` after model loads
//! - `Touch` on click/tap hit areas
//! - `MotionRequest` / `ExpressionRequest` for manual control

use serde::{Deserialize, Serialize};

// ── Server → Client ──────────────────────────────────────────────

/// Messages from server to the Live2D frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AvatarNotification {
    /// Connection acknowledged.
    Connected { session_id: String },

    /// Model loading instruction (sent immediately after connect).
    ModelInfo {
        /// URL or relative path to the Live2D model directory.
        model_url: String,
        /// Scale factor for the model.
        scale: f32,
        /// Position anchor (e.g. "center", "bottom-left").
        anchor: String,
        /// Expression to apply on idle.
        default_expression: String,
    },

    /// Expression change command.
    Expression {
        /// Expression name matching a Live2D expression in the model.
        name: String,
        /// Intensity 0.0–1.0.
        intensity: f32,
        /// Duration in ms to hold the expression before returning to idle.
        duration_ms: Option<u32>,
    },

    /// Motion trigger (e.g. wave, nod, shake).
    Motion {
        /// Motion group name (e.g. "Idle", "TapBody").
        group: String,
        /// Motion name within the group.
        name: String,
    },

    /// Audio data with associated lip sync frames.
    ///
    /// For sentence-chunked synthesis a single agent reply may produce
    /// multiple Audio frames in sequence. The frontend uses
    /// `turn_id` + `seq` to queue chunks of the same turn back-to-back
    /// without overlap, while a new `turn_id` interrupts the queue.
    Audio {
        /// Base64-encoded audio bytes.
        audio: String,
        /// Audio format ("wav", "mp3", "pcm").
        format: String,
        /// Sample rate in Hz.
        sample_rate: u32,
        /// Lip sync frame data synchronized to audio.
        lip_sync: LipSyncDataProto,
        /// Stable id for the agent turn this chunk belongs to. All
        /// chunks of the same turn share this; a different value means
        /// the user sent a new message and the queue should be flushed.
        #[serde(default)]
        turn_id: String,
        /// 0-based index of this chunk within its turn.
        #[serde(default)]
        seq: u32,
        /// True for the last chunk of a turn. After this fires the
        /// frontend can clear "speaking" state once playback finishes.
        #[serde(default)]
        last: bool,
    },

    /// Agent text for optional subtitle display. Always in the chat
    /// language (companion.toml `[avatar] chat_language`), regardless
    /// of what TTS speaks.
    Text { content: String },

    /// User's typed message, echoed to every connected WS client so
    /// chat history stays consistent across windows. The overlay
    /// (desktop-pet) window can accept input but isn't authoritative
    /// for chat history; without this echo, a user message typed in
    /// the overlay would never reach the main window's chat panel.
    UserMessage { content: String },

    /// Optional debug frame: what the subagent actually fed to TTS,
    /// alongside metadata about the analysis. Helps users verify the
    /// translation is happening (and is correct) without reading
    /// server logs.
    Debug {
        /// Original chat-language text the subagent received.
        chat_text: String,
        /// What the subagent decided to speak (this is what TTS got).
        /// Equals `chat_text` when chat_language == tts_language.
        spoken_text: String,
        /// Live2D expression name the subagent picked.
        expression: String,
        /// Whether the subagent ran successfully (true) or fell back
        /// to keyword detection because it failed/was disabled (false).
        subagent_used: bool,
        /// Which backend produced the spoken text. Lets the UI label
        /// the analysis path honestly instead of always saying
        /// "LLM-driven" (which was wrong for local-NMT mode — verified
        /// by the user iter 14). Values:
        /// - "llm"  — direct LLM or zeroclaw webhook proxy
        /// - "nmt"  — local NMT sidecar (translator.backend = "http")
        /// - "none" — chat_language == tts_language; no translation
        #[serde(default)]
        translation_path: String,
    },

    /// Idle state — no audio playing, return to neutral pose.
    Idle,

    /// Error notification.
    Error { message: String },
}

// ── Client → Server ──────────────────────────────────────────────

/// Messages from the Live2D frontend to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AvatarMessage {
    /// Client has loaded the model and is ready for data.
    Ready,

    /// Touch/hit area event from the Live2D model.
    Touch {
        /// Hit area name (e.g. "head", "body", "arm").
        hit_area: String,
        /// X coordinate relative to model.
        x: f32,
        /// Y coordinate relative to model.
        y: f32,
    },

    /// Request to play a specific motion.
    MotionRequest { group: String, name: String },

    /// Request to change expression.
    ExpressionRequest { name: String },
}

// ── Lip sync data (wire format) ─────────────────────────────────

/// Protocol-friendly lip sync data for transport over WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LipSyncDataProto {
    /// Lip sync frames.
    pub frames: Vec<LipSyncFrameProto>,
    /// Duration of each frame in milliseconds.
    pub frame_duration_ms: u32,
}

/// A single lip sync frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LipSyncFrameProto {
    /// Timestamp in milliseconds from audio start.
    pub t: u32,
    /// Mouth open amount 0.0–1.0.
    pub o: f32,
    /// Mouth smile amount -1.0–1.0.
    pub s: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_avatar_notification_connected() {
        let msg = AvatarNotification::Connected {
            session_id: "test-123".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"Connected\""));
        assert!(json.contains("\"session_id\":\"test-123\""));
    }

    #[test]
    fn serialize_avatar_notification_audio() {
        let msg = AvatarNotification::Audio {
            audio: "dGVzdA==".to_string(),
            format: "wav".to_string(),
            sample_rate: 22050,
            turn_id: "t-1".into(),
            seq: 0,
            last: true,
            lip_sync: LipSyncDataProto {
                frames: vec![LipSyncFrameProto {
                    t: 0,
                    o: 0.5,
                    s: 0.0,
                }],
                frame_duration_ms: 30,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"Audio\""));
        assert!(json.contains("\"sample_rate\":22050"));
    }

    #[test]
    fn deserialize_avatar_message_ready() {
        let json = r#"{"type":"Ready"}"#;
        let msg: AvatarMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, AvatarMessage::Ready));
    }

    #[test]
    fn deserialize_avatar_message_touch() {
        let json = r#"{"type":"Touch","hit_area":"head","x":100.0,"y":200.0}"#;
        let msg: AvatarMessage = serde_json::from_str(json).unwrap();
        match msg {
            AvatarMessage::Touch { hit_area, x, y } => {
                assert_eq!(hit_area, "head");
                assert!((x - 100.0).abs() < f32::EPSILON);
                assert!((y - 200.0).abs() < f32::EPSILON);
            }
            other => panic!("expected Touch, got: {other:?}"),
        }
    }

    // ── Additional coverage ────────────────────────────────────────

    #[test]
    fn serialize_avatar_notification_text() {
        let msg = AvatarNotification::Text {
            content: "subtitle 字幕".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"Text\""));
        assert!(json.contains("subtitle"));
        assert!(json.contains("字幕"));
    }

    #[test]
    fn serialize_avatar_notification_user_message() {
        let msg = AvatarNotification::UserMessage {
            content: "hello from overlay".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"UserMessage\""));
        assert!(json.contains("hello from overlay"));
    }

    #[test]
    fn serialize_avatar_notification_debug() {
        let msg = AvatarNotification::Debug {
            chat_text: "Hi".into(),
            spoken_text: "こんにちは".into(),
            expression: "F05".into(),
            subagent_used: true,
            translation_path: "nmt".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"Debug\""));
        assert!(json.contains("\"translation_path\":\"nmt\""));
        assert!(json.contains("\"subagent_used\":true"));
    }

    #[test]
    fn serialize_avatar_notification_idle() {
        let msg = AvatarNotification::Idle;
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, "{\"type\":\"Idle\"}");
    }

    #[test]
    fn serialize_avatar_notification_error() {
        let msg = AvatarNotification::Error {
            message: "TTS dead".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"Error\""));
        assert!(json.contains("TTS dead"));
    }

    #[test]
    fn deserialize_avatar_message_motion_request() {
        let json = r#"{"type":"MotionRequest","group":"TapBody","name":"motion-1"}"#;
        let msg: AvatarMessage = serde_json::from_str(json).unwrap();
        match msg {
            AvatarMessage::MotionRequest { group, name } => {
                assert_eq!(group, "TapBody");
                assert_eq!(name, "motion-1");
            }
            other => panic!("expected MotionRequest, got: {other:?}"),
        }
    }

    #[test]
    fn deserialize_avatar_message_expression_request() {
        let json = r#"{"type":"ExpressionRequest","name":"F05"}"#;
        let msg: AvatarMessage = serde_json::from_str(json).unwrap();
        match msg {
            AvatarMessage::ExpressionRequest { name } => {
                assert_eq!(name, "F05");
            }
            other => panic!("expected ExpressionRequest, got: {other:?}"),
        }
    }

    #[test]
    fn audio_frame_defaults_for_missing_optionals() {
        // turn_id, seq, last all use #[serde(default)]; deser without them.
        let json = r#"{
            "type": "Audio",
            "audio": "AAAA",
            "format": "wav",
            "sample_rate": 22050,
            "lip_sync": {"frames": [], "frame_duration_ms": 30}
        }"#;
        let msg: AvatarNotification = serde_json::from_str(json).unwrap();
        match msg {
            AvatarNotification::Audio {
                turn_id, seq, last, ..
            } => {
                assert_eq!(turn_id, "");
                assert_eq!(seq, 0);
                assert!(!last);
            }
            other => panic!("expected Audio, got {other:?}"),
        }
    }

    #[test]
    fn lip_sync_frame_proto_serializes_compact_keys() {
        // Wire format uses short keys (t, o, s) to keep the per-frame
        // payload small — verify they're stable.
        let frame = LipSyncFrameProto {
            t: 100,
            o: 0.5,
            s: -0.2,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"t\":100"), "got {json}");
        assert!(json.contains("\"o\":0.5"), "got {json}");
        assert!(json.contains("\"s\":-0.2"), "got {json}");
    }

    #[test]
    fn expression_with_no_duration_serializes_as_null() {
        let msg = AvatarNotification::Expression {
            name: "smile".into(),
            intensity: 0.8,
            duration_ms: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"duration_ms\":null"));
    }
}
